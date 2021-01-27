import * as vscode from 'vscode';
import * as cfg from './configuration';
import * as util from './utility';
import { CSymbol } from './CSymbol';
import { SourceFile } from './SourceFile';
import { SourceSymbol } from './SourceSymbol';
import { ProposedPosition } from "./ProposedPosition";


export class SourceDocument extends SourceFile
{
    readonly document: vscode.TextDocument;

    constructor(document: vscode.TextDocument, sourceFile?: SourceFile)
    {
        super(document.uri);
        this.document = document;
        this.symbols = sourceFile?.symbols;
    }

    static async open(uri: vscode.Uri): Promise<SourceDocument>
    {
        const document = await vscode.workspace.openTextDocument(uri);
        return new SourceDocument(document);
    }

    text(): string { return this.document.getText(); }

    async getSymbol(position: vscode.Position): Promise<CSymbol | undefined>
    {
        const sourceSymbol = await super.getSymbol(position);
        if (!sourceSymbol) {
            return;
        }

        return new CSymbol(sourceSymbol, this.document);
    }

    async findMatchingSymbol(target: SourceSymbol): Promise<CSymbol | undefined>
    {
        const sourceSymbol = await super.findMatchingSymbol(target);
        if (!sourceSymbol) {
            return;
        }

        return new CSymbol(sourceSymbol, this.document);
    }

    async hasHeaderGuard(): Promise<boolean>
    {
        if (this.text().match(/^\s*#pragma\s+once\b/)) {
            return true;
        }

        if (!this.symbols) {
            this.symbols = await this.executeSourceSymbolProvider();
        }

        const headerGuardDefine = cfg.headerGuardDefine(util.fileName(this.uri.path));
        for (const symbol of this.symbols) {
            if (symbol.kind === vscode.SymbolKind.Constant && symbol.name === headerGuardDefine) {
                return true;
            }
        }

        return false;
    }

    // Returns the best position to place the definition for declaration.
    // If targetDoc is undefined the position will be for this SourceFile.
    async findPositionForFunctionDefinition(
        declaration: SourceSymbol, targetDoc?: SourceDocument
    ): Promise<ProposedPosition> {
        if (!this.symbols) {
            this.symbols = await this.executeSourceSymbolProvider();
        }
        if (declaration.uri.path !== this.uri.path || (!declaration.parent && this.symbols.length === 0)) {
            return { value: new vscode.Position(0, 0) };
        }

        if (!targetDoc) {
            targetDoc = this;
        }
        if (!targetDoc.symbols) {
            targetDoc.symbols = await targetDoc.executeSourceSymbolProvider();
            if (targetDoc.symbols.length === 0) {
                // If the targetDoc has no symbols then place the new definiton after the last non-empty line.
                for (let i = targetDoc.document.lineCount - 1; i >= 0; --i) {
                    if (!targetDoc.document.lineAt(i).isEmptyOrWhitespace) {
                        return { value: targetDoc.document.lineAt(i).range.end, after: true };
                    }
                }
                return { value: new vscode.Position(0, 0) };
            }
        }

        // Get the first 5 symbols that come before and after declaration.
        // We look for definitions of these symbols in targetDoc and return a position relative to the closest one.
        const siblingSymbols = declaration.parent ? declaration.parent.children : this.symbols;
        let relativeSymbolIndex = 0;
        for (const symbol of siblingSymbols) {
            if (symbol.range.isEqual(declaration.range)) {
                break;
            }
            ++relativeSymbolIndex;
        }
        const start = Math.max(relativeSymbolIndex - 5, 0);
        const end = Math.min(relativeSymbolIndex + 6, siblingSymbols.length);
        const before = siblingSymbols.slice(start, relativeSymbolIndex);
        const after = siblingSymbols.slice(relativeSymbolIndex + 1, end);

        // Find a definition of a sibling symbol in targetDoc.
        for (const symbol of before.reverse()) {
            const definitionLocation = await symbol.findDefinition();
            if (!definitionLocation || definitionLocation.uri.path !== targetDoc.uri.path) {
                continue;
            }

            const definition = await targetDoc.getSymbol(definitionLocation.range.start);
            if (definition) {
                return { value: targetDoc.getEndOfStatement(definition.range.end), after: true };
            }
        }
        for (const symbol of after) {
            const definitionLocation = await symbol.findDefinition();
            if (!definitionLocation || definitionLocation.uri.path !== targetDoc.uri.path) {
                continue;
            }

            const definition = await targetDoc.getSymbol(definitionLocation.range.start);
            if (definition) {
                return { value: definition.range.start, before: true };
            }
        }

        // If a sibling definition couldn't be found in targetDoc, look for a cooresponding namespace block.
        for (const scope of declaration.scopes().reverse()) {
            if (scope.kind === vscode.SymbolKind.Namespace) {
                const targetNamespace = await targetDoc.findMatchingSymbol(scope);
                if (!targetNamespace) {
                    continue;
                }

                if (targetNamespace.children.length === 0) {
                    const bodyStart = targetDoc.document.offsetAt(targetNamespace.range.start)
                            + targetNamespace.text().indexOf('{') + 1;
                    return { value: targetDoc.document.positionAt(bodyStart), after: true, nextTo: true, emptyScope: true };
                }
                return {
                    value: targetDoc.getEndOfStatement(targetNamespace.children[targetNamespace.children.length - 1].range.end),
                    after: true
                };
            }
        }

        // If all else fails then return a position after the last symbol in the document.
        return {
            value: targetDoc.getEndOfStatement(targetDoc.symbols[targetDoc.symbols.length - 1].range.end),
            after: true
        };
    }

    // Returns the best positions to place new includes (system and project includes).
    async findPositionForNewInclude(): Promise<{ system: vscode.Position; project: vscode.Position }>
    {
        // TODO: Clean up this mess.
        const largestBlock = (
            line: vscode.TextLine, start: vscode.Position, largest: vscode.Range | undefined
        ): vscode.Range => {
            const r = new vscode.Range(start, line.range.start);
            return (!largest || r > largest) ? r : largest;
        };

        let systemIncludeStart: vscode.Position | undefined;
        let projectIncludeStart: vscode.Position | undefined;
        let largestSystemIncludeBlock: vscode.Range | undefined;
        let largestProjectIncludeBlock: vscode.Range | undefined;
        for (let i = 0; i < this.document.lineCount; ++i) {
            const line = this.document.lineAt(i);
            if (!line.text.trim().match(/^#include\s*(<.+>)|(".+")$/)) {
                if (systemIncludeStart) {
                    largestSystemIncludeBlock = largestBlock(line, systemIncludeStart, largestSystemIncludeBlock);
                    systemIncludeStart = undefined;
                } else if (projectIncludeStart) {
                    largestProjectIncludeBlock = largestBlock(line, projectIncludeStart, largestProjectIncludeBlock);
                    projectIncludeStart = undefined;
                }
            } else if (line.text.match(/<.+>/)) {
                if (!systemIncludeStart) {
                    systemIncludeStart = line.range.start;
                }
                if (projectIncludeStart) {
                    largestProjectIncludeBlock = largestBlock(line, projectIncludeStart, largestProjectIncludeBlock);
                    projectIncludeStart = undefined;
                }
            } else if (line.text.match(/".+"/)) {
                if (!projectIncludeStart) {
                    projectIncludeStart = line.range.start;
                }
                if (systemIncludeStart) {
                    largestSystemIncludeBlock = largestBlock(line, systemIncludeStart, largestSystemIncludeBlock);
                    systemIncludeStart = undefined;
                }
            }
        }

        let systemIncludePos: vscode.Position | undefined;
        let projectIncludePos: vscode.Position | undefined;
        if (largestSystemIncludeBlock) {
            systemIncludePos = largestSystemIncludeBlock.end;
            if (!largestProjectIncludeBlock) {
                projectIncludePos = systemIncludePos;
            }
        }
        if (largestProjectIncludeBlock) {
            projectIncludePos = largestProjectIncludeBlock.end;
            if (!largestSystemIncludeBlock) {
                systemIncludePos = projectIncludePos;
            }
        }
        if (systemIncludePos && projectIncludePos) {
            return { system: systemIncludePos, project: projectIncludePos };
        }

        let startLineNum = this.document.lineCount - 1;
        if (!this.symbols) {
            this.symbols = await this.executeSourceSymbolProvider();
        }
        if (this.symbols.length === 0) {
            startLineNum = this.document.lineCount - 1;
        } else {
            startLineNum = this.symbols[0].range.start.line;
        }

        for (let i = startLineNum; i >= 0; --i) {
            const line = this.document.lineAt(i);
            if (!line.isEmptyOrWhitespace) {
                return { system: line.range.end, project: line.range.end };
            }
        }

        return { system: new vscode.Position(0, 0), project: new vscode.Position(0, 0) };
    }

    // Finds a position for a header guard by skipping over any comments that appear at the top of the file.
    findPositionForNewHeaderGuard(): ProposedPosition
    {
        const maskedText = this.text().replace(/\/\*(\*(?=\/)|[^*])*\*\//g, match => ' '.repeat(match.length))
                                      .replace(/\/\/.*/g, match => ' '.repeat(match.length));
        let match = maskedText.match(/\S/);
        if (typeof match?.index === 'number') {
            return {
                value: this.document.positionAt(match.index),
                before: true
            };
        }

        const endTrimmedTextLength = this.text().trimEnd().length;
        return {
            value: this.document.positionAt(endTrimmedTextLength),
            after: endTrimmedTextLength !== 0
        };
    }

    // DocumentSymbol ranges don't always include the final semi-colon.
    private getEndOfStatement(position: vscode.Position): vscode.Position
    {
        let nextPosition = position.translate(0, 1);
        while (this.document.getText(new vscode.Range(position, nextPosition)) === ';') {
            position = nextPosition;
            nextPosition = position.translate(0, 1);
        }
        return position;
    }
}
