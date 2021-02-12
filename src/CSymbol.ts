import * as vscode from 'vscode';
import * as cfg from './configuration';
import * as util from './utility';
import { SourceSymbol } from './SourceSymbol';
import { ProposedPosition } from './ProposedPosition';
import { SourceFile } from './SourceFile';
import { SourceDocument } from './SourceDocument';

const re_primitiveTypes = /\b(void|bool|char|wchar_t|char8_t|char16_t|char32_t|int|short|long|signed|unsigned|float|double)\b/g;
const re_blockComments = /\/\*(\*(?!\/)|[^*])*\*\//gm;
// Only matches identifiers that are not folowed by a scope resolution operator (::).
const re_scopeResolvedIdentifier = /[\w_][\w\d_]*\b(?!\s*::)/;
const re_beginingOfScopeString = /(?<!::\s*|[\w\d_])[\w_][\w\d_]*(?=\s*::)/g;


/**
 * Extends SourceSymbol by adding a document property that gives more semantic-awareness over SourceSymbol.
 */
export class CSymbol extends SourceSymbol
{
    readonly document: vscode.TextDocument;
    parent?: CSymbol;
    private trueStart?: vscode.Position;
    private headerCommentStart?: vscode.Position;

    /**
     * When constructing with a SourceSymbol that has a parent, the parent parameter may be omitted.
     */
    constructor(symbol: vscode.DocumentSymbol | SourceSymbol, document: vscode.TextDocument, parent?: CSymbol)
    {
        super(symbol, document.uri, parent);
        this.document = document;

        if (symbol instanceof SourceSymbol && symbol.parent && !parent) {
            this.parent = new CSymbol(symbol.parent, document);
        } else {
            this.parent = parent;
        }

        this.range = this.range.with(this.range.start, util.getEndOfStatement(this.document, this.range.end));
    }

    findChild(compareFn: (child: CSymbol) => boolean): CSymbol | undefined
    {
        for (const symbol of this.children) {
            const child = new CSymbol(symbol, this.document);
            if (compareFn(child)) {
                return child;
            }
        }
    }

    /**
     * Returns the text contained in this symbol.
     */
    text(): string { return this.document.getText(this.range); }

    /**
     * Returns the text contained in this symbol with comments masked with spaces.
     */
    get parsableText(): string
    {
        if (this._parsableText) {
            return this._parsableText;
        }
        this._parsableText = util.maskComments(this.text(), false);
        return this._parsableText;
    }
    private _parsableText?: string;

    /**
     * Returns the text of this symbol including potential template statement.
     */
    getFullText(): string { return this.document.getText(this.getFullRange()); }

    getTextWithLeadingComment(): string
    {
        return this.document.getText(this.getRangeWithLeadingComment());
    }

    async getTextForTargetPosition(
        target: SourceDocument, position: vscode.Position, declaration?: SourceSymbol
    ): Promise<string> {
        if (!declaration && SourceFile.isHeader(this.uri)
                && (this.parent?.isClassOrStruct() || this.parent?.kind === vscode.SymbolKind.Namespace)) {
            const bodyRange = new vscode.Range(this.bodyStart(), this.range.end);
            const bodyText = this.document.getText(bodyRange);
            // This CSymbol is a definition, but it can be treated as a declaration for the purpose of this function.
            return await this.formatDeclarationForNewDefinition(target, position) + bodyText;
        }

        const scopeString = declaration !== undefined
                ? await declaration.scopeString(target, position)
                : await this.scopeString(target, position);

        const nameToEndRange = new vscode.Range(this.selectionRange.start, this.range.end);
        const nameToEndText = this.document.getText(nameToEndRange);

        const leadingRange = new vscode.Range(this.getLeadingCommentStart(), this.scopeStringStart());
        const leadingText = this.document.getText(leadingRange);

        return leadingText + scopeString + nameToEndText;
    }

    /**
     * Returns the text contained in this symbol that comes before this.selectionRange.
     */
    leadingText(): string
    {
        return this.document.getText(new vscode.Range(this.range.start, this.selectionRange.start));
    }

    /**
     * Returns the text contained in this symbol that comes before this.selectionRange,
     * including potential template statement.
     */
    getFullLeadingText(): string
    {
        return this.document.getText(new vscode.Range(this.getTrueStart(), this.selectionRange.start));
    }

    /**
     * Returns the range of this symbol including potential template statement.
     */
    getFullRange(): vscode.Range { return new vscode.Range(this.getTrueStart(), this.range.end); }

    getRangeWithLeadingComment(): vscode.Range
    {
        return new vscode.Range(this.getLeadingCommentStart(), this.range.end);
    }

    startOffset(): number { return this.document.offsetAt(this.range.start); }

    endOffset(): number { return this.document.offsetAt(this.range.end); }

    isBefore(offset: number): boolean { return this.endOffset() < offset; }

    isAfter(offset: number): boolean { return this.startOffset() > offset; }

    /**
     * Finds a position for a new public member function within this class or struct. Optionally provide a
     * relativeName to look for a position next to. Optionally provide a memberVariable if the new member function
     * is an accessor. Returns undefined if this is not a class or struct, or when this.children.length === 0.
     */
    findPositionForNewMemberFunction(
        relativeName?: string, memberVariable?: SourceSymbol
    ): ProposedPosition | undefined {
        if (!this.isClassOrStruct()) {
            return this.positionAfterLastChildOrUndefined();
        }

        const startOffset = this.startOffset();
        let publicSpecifierOffset = /\bpublic\s*:/g.exec(this.parsableText)?.index;

        if (!publicSpecifierOffset) {
            return this.positionAfterLastChildOrUndefined();
        }
        publicSpecifierOffset += startOffset;

        let nextAccessSpecifierOffset: number | undefined;
        for (const match of this.parsableText.matchAll(/\w[\w\d]*\s*:(?!:)/g)) {
            if (!match.index) {
                continue;
            }
            if (match.index > publicSpecifierOffset) {
                nextAccessSpecifierOffset = match.index;
                break;
            }
        }

        if (nextAccessSpecifierOffset === undefined) {
            nextAccessSpecifierOffset = this.endOffset();
        } else {
            nextAccessSpecifierOffset += startOffset;
        }

        let fallbackPosition: ProposedPosition | undefined;
        let fallbackIndex: number | undefined;
        for (let i = this.children.length - 1; i >= 0; --i) {
            const symbol = new CSymbol(this.children[i], this.document, this);
            if (this.isChildFunctionBetween(symbol, publicSpecifierOffset, nextAccessSpecifierOffset)) {
                fallbackPosition = new ProposedPosition(symbol.range.end, {
                    relativeTo: symbol.range,
                    after: true
                });
                fallbackIndex = i;
                break;
            }
        }

        if (!fallbackPosition || fallbackIndex === undefined) {
            return this.positionAfterLastChildOrUndefined();
        } else if (!relativeName) {
            return fallbackPosition;
        }

        /* If relativeName is a setterName, then ProposedPosition should be before, since the new member function is
         * a getter. This is to match the positioning of these members when both are generated at the same time. */
        const isGetter = memberVariable ? relativeName === memberVariable.setterName() : false;

        for (let i = fallbackIndex; i >= 0; --i) {
            const symbol = new CSymbol(this.children[i], this.document, this);
            if (this.isChildFunctionBetween(symbol, publicSpecifierOffset, nextAccessSpecifierOffset)
                    && symbol.name === relativeName) {
                if (isGetter) {
                    return new ProposedPosition(symbol.getLeadingCommentStart(), {
                        relativeTo: symbol.range,
                        before: true,
                        nextTo: true
                    });
                }
                return new ProposedPosition(symbol.range.end, {
                    relativeTo: symbol.range,
                    after: true,
                    nextTo: true
                });
            }
        }

        return fallbackPosition;
    }

    isFunctionDeclaration(): boolean
    {
        return this.isFunction() && (this.detail === 'declaration' || !this.parsableText.endsWith('}'));
    }

    isFunctionDefinition(): boolean
    {
        return this.isFunction() && !this.isFunctionDeclaration();
    }

    isConstexpr(): boolean
    {
        if (this.leadingText().match(/\bconstexpr\b/)) {
            return true;
        }
        return false;
    }

    isInline(): boolean
    {
        if (this.leadingText().match(/\binline\b/)) {
            return true;
        }
        return false;
    }

    isPointer(): boolean
    {
        return util.maskAngleBrackets(this.leadingText().replace(re_blockComments, '')).includes('*');
    }

    isConst(): boolean
    {
        if (util.maskAngleBrackets(this.leadingText().replace(re_blockComments, '')).match(/\bconst\b/)) {
            return true;
        }
        return false;
    }

    isTypedef(): boolean
    {
        return this.mightBeTypedefOrTypeAlias() && this.parsableText.match(/\btypedef\b/) !== null;
    }

    isTypeAlias(): boolean
    {
        if (this.mightBeTypedefOrTypeAlias()) {
            return this.parsableText.match(/\busing\b/) !== null && this.parsableText.includes('=');
        }
        return false;
    }

    async isPrimitive(): Promise<boolean>
    {
        if (this.isVariable()) {
            const leadingText = this.leadingText().replace(re_blockComments, util.masker);
            if (this.matchesPrimitiveType(leadingText)) {
                return true;
            } else if (!cfg.resolveTypes()) {
                return false;
            }

            const type = leadingText.replace(/\b(static|const|constexpr|inline|mutable)\b/g, util.masker);
            const match = type.match(re_scopeResolvedIdentifier);
            if (match?.index !== undefined) {
                return await this.resolveThisType(this.startOffset() + match.index);
            }
        } else if (this.isTypedef()) {
            if (this.matchesPrimitiveType(this.parsableText)) {
                return true;
            } else if (this.parsableText.match(/\b(struct|class|(<(>(?=>)|[^>])*>))\b/)) {
                return false;
            } else if (!cfg.resolveTypes()) {
                return false;
            }

            const maskedText = this.parsableText.replace(/\b(typedef|const)\b/g, util.masker);
            const match = maskedText.match(re_scopeResolvedIdentifier);
            if (match?.index !== undefined) {
                return await this.resolveThisType(this.startOffset() + match.index);
            }
        } else if (this.isTypeAlias()) {
            if (this.matchesPrimitiveType(this.parsableText)) {
                return true;
            } else if (this.parsableText.match(/\b(struct|class|(<(>(?=>)|[^>])*>))\b/)) {
                return false;
            } else if (!cfg.resolveTypes()) {
                return false;
            }

            const indexOfEquals = this.parsableText.indexOf('=');
            if (indexOfEquals === -1) {
                return false;
            }

            const type = this.parsableText.substring(indexOfEquals + 1);
            const match = type.match(re_scopeResolvedIdentifier);
            if (match?.index !== undefined) {
                return await this.resolveThisType(this.startOffset() + match.index);
            }
        }

        return false;
    }

    private async resolveThisType(offset: number): Promise<boolean>
    {
        const sourceDoc = (this.document instanceof SourceDocument) ? this.document : new SourceDocument(this.document);
        const locations = await sourceDoc.findDefintions(this.document.positionAt(offset));

        if (locations.length > 0) {
            const typeFile = new SourceFile(locations[0].uri);
            const typeSymbol = await typeFile.getSymbol(locations[0].range.start);

            if (typeSymbol?.kind === vscode.SymbolKind.Enum) {
                return true;
            } else if (typeSymbol?.mightBeTypedefOrTypeAlias()) {
                const typeDoc = await typeFile.openDocument();
                const typeCSymbol = new CSymbol(typeSymbol, typeDoc);
                return await typeCSymbol.isPrimitive();
            }
        }

        return false;
    }

    /**
     * Formats this function declaration for use as a definition (without curly braces).
     */
    async newFunctionDefinition(targetDoc: SourceDocument, position: vscode.Position): Promise<string>
    {
        if (!this.isFunctionDeclaration()) {
            return '';
        }
        return this.formatDeclarationForNewDefinition(targetDoc, position);
    }

    private async formatDeclarationForNewDefinition(
        targetDoc: SourceDocument, position: vscode.Position
    ): Promise<string> {
        const p_scopeString = this.scopeString(targetDoc, position);

        const declarationRange = new vscode.Range(this.getTrueStart(), this.bodyStart());
        const declaration = this.document.getText(declarationRange).replace(/;$/, '');
        let maskedDeclaration = util.maskComments(declaration, false);
        maskedDeclaration = util.maskQuotes(maskedDeclaration);
        maskedDeclaration = util.maskParentheses(maskedDeclaration);

        const nameEndIndex = this.document.offsetAt(this.selectionRange.end) - this.document.offsetAt(this.getTrueStart());
        const paramStartIndex = maskedDeclaration.indexOf('(', nameEndIndex) + 1;
        const paramEndIndex = maskedDeclaration.indexOf(')');
        if (paramStartIndex === -1 || paramEndIndex === -1) {
            return '';
        }
        const parameters = this.stripDefaultValues(declaration.substring(paramStartIndex, paramEndIndex));

        // Intelligently align the definition in the case of a multi-line declaration.
        let leadingText = this.document.getText(new vscode.Range(this.getTrueStart(), this.scopeStringStart()));
        const line = this.document.lineAt(this.range.start);
        const leadingIndent = line.text.substring(0, line.firstNonWhitespaceCharacterIndex).length;
        const leadingLines = leadingText.split(targetDoc.endOfLine);
        const alignLength = leadingLines[leadingLines.length - 1].length;
        const re_newLineAlignment = new RegExp('^' + ' '.repeat(leadingIndent + alignLength), 'gm');
        leadingText = leadingText.replace(/\b(virtual|static|explicit|friend)\b\s*/g, '');
        leadingText = leadingText.replace(/^\s+/gm, '');
        let definition = this.name + '(' + parameters + ')' + declaration.substring(paramEndIndex + 1);

        return new Promise(resolve => {
            p_scopeString.then(scopeString => {
                definition = definition.replace(re_newLineAlignment, ' '.repeat(alignLength + scopeString.length));
                definition = leadingText + scopeString + definition;
                resolve(definition.replace(/\s*\b(override|final)\b/g, ''));
            });
        });
    }

    newFunctionDeclaration(): string
    {
        if (!this.isFunctionDefinition()) {
            return '';
        }
        return this.document.getText(new vscode.Range(this.getTrueStart(), this.bodyStart())).trimEnd() + ';';
    }

    combineDefinition(definition: CSymbol): string
    {
        const body = definition.document.getText(new vscode.Range(definition.bodyStart(this), definition.range.end));
        const re_oldIndentation = util.getIndentationRegExp(definition);
        const line = this.document.lineAt(this.range.start);
        const newIndentation = line.text.substring(0, line.firstNonWhitespaceCharacterIndex);

        if (!this.hasLeadingComment()) {
            const leadingCommentRange = new vscode.Range(definition.getLeadingCommentStart(), definition.getTrueStart());
            const leadingComment = definition.document.getText(leadingCommentRange);
            return leadingComment.replace(re_oldIndentation, '').replace(/\n/gm, '\n' + newIndentation)
                    + this.getFullText().replace(/\s*;$/, '')
                    + body.replace(re_oldIndentation, '').replace(/\n/gm, '\n' + newIndentation);
        }

        return this.getFullText().replace(/\s*;$/, '') + body.replace(re_oldIndentation, '').replace(/\n/gm, '\n' + newIndentation);
    }

    /**
     * clangd and ccls don't include template statements in provided DocumentSymbols.
     */
    getTrueStart(): vscode.Position
    {
        if (this.trueStart) {
            return this.trueStart;
        }

        const before = new vscode.Range(new vscode.Position(0, 0), this.range.start);
        let maskedText = util.maskComments(this.document.getText(before), false);
        maskedText = util.maskQuotes(maskedText, false);
        maskedText = util.maskAngleBrackets(maskedText, true).trimEnd();
        if (!maskedText.endsWith('>')) {
            return this.range.start;
        }

        let lastMatch: RegExpMatchArray | undefined;
        for (const match of maskedText.matchAll(/\btemplate\s*<.+>/g)) {
            lastMatch = match;
        }
        if (!lastMatch?.index) {
            return this.range.start;
        }

        this.trueStart = this.document.positionAt(lastMatch.index);
        return this.trueStart;
    }

    /**
     * Less of the body start, and more of "the end of the declaration part of the definition", but that's really long.
     */
    private bodyStart(declaration?: CSymbol): vscode.Position
    {
        let maskedText = util.maskQuotes(this.parsableText);
        maskedText = util.maskParentheses(maskedText, true);
        const startOffset = this.document.offsetAt(this.range.start);
        const nameEndIndex = this.document.offsetAt(this.selectionRange.end) - startOffset;
        const bodyStartIndex = maskedText.substring(nameEndIndex).match(/\s*{/)?.index;
        if (!bodyStartIndex) {
            return this.range.end;
        }

        if (!this.isConstructor() && !declaration?.isConstructor()) {
            return this.document.positionAt(startOffset + nameEndIndex + bodyStartIndex);
        }

        // Get the start of the constructor's member initializer list, if one is present.
        const initializerIndex = maskedText.substring(nameEndIndex, bodyStartIndex + nameEndIndex).match(/\s*:(?!:)/)?.index;
        if (!initializerIndex) {
            return this.document.positionAt(startOffset + nameEndIndex + bodyStartIndex);
        }
        return this.document.positionAt(startOffset + nameEndIndex + initializerIndex);
    }

    private stripDefaultValues(parameters: string): string
    {
        // Mask anything that might contain commas or equals-signs.
        let maskedParameters = util.maskComments(parameters);
        maskedParameters = util.maskQuotes(maskedParameters);
        maskedParameters = util.maskParentheses(maskedParameters);
        maskedParameters = util.maskAngleBrackets(maskedParameters);
        maskedParameters = util.maskBraces(maskedParameters);
        maskedParameters = util.maskBrackets(maskedParameters);
        maskedParameters = util.maskComparisonOperators(maskedParameters);

        let splitParameters = maskedParameters.split(',');
        let strippedParameters = '';
        let charPos = 0;
        for (const parameter of splitParameters) {
            if (parameter.includes('=')) {
                strippedParameters += parameters.substring(charPos, charPos + parameter.indexOf('=')).trimEnd() + ',';
            } else {
                strippedParameters += parameters.substring(charPos, charPos + parameter.length) + ',';
            }
            charPos += parameter.length + 1;
        }

        return strippedParameters.substring(0, strippedParameters.length - 1);
    }

    private scopeStringStart(): vscode.Position
    {
        const maskedLeadingText = util.maskComments(this.leadingText()).trimEnd();
        if (!maskedLeadingText.endsWith('::')) {
            return this.selectionRange.start;
        }

        let lastMatch: RegExpMatchArray | undefined;
        for (const match of maskedLeadingText.matchAll(re_beginingOfScopeString)) {
            lastMatch = match;
        }
        if (lastMatch?.index === undefined) {
            return this.selectionRange.start;
        }

        return this.document.positionAt(this.startOffset() + lastMatch.index);
    }

    hasLeadingComment(): boolean
    {
        if (this.getLeadingCommentStart().isEqual(this.getTrueStart())) {
            return false;
        }
        return true;
    }

    getLeadingCommentStart(): vscode.Position
    {
        if (this.headerCommentStart) {
            return this.headerCommentStart;
        }

        const before = new vscode.Range(new vscode.Position(0, 0), this.getTrueStart());
        const maskedText = util.maskComments(this.document.getText(before), true).trimEnd();
        if (!maskedText.endsWith('//') && !maskedText.endsWith('*/')) {
            this.headerCommentStart = this.getTrueStart();
            return this.headerCommentStart;
        }

        if (maskedText.endsWith('*/')) {
            const commentStartOffset = maskedText.lastIndexOf('/*');
            if (commentStartOffset !== -1) {
                this.headerCommentStart = this.document.positionAt(commentStartOffset);
                return this.headerCommentStart;
            }
            this.headerCommentStart = this.getTrueStart();
            return this.headerCommentStart;
        }

        for (let i = this.getTrueStart().line - 1; i >= 0; --i) {
            const line = this.document.lineAt(i);
            if (!line.text.trimStart().startsWith('//')) {
                const indexOfComment = this.document.lineAt(i + 1).text.indexOf('//');
                if (indexOfComment === -1) {
                    break;  // This shouldn't happen, but just in-case.
                }
                this.headerCommentStart = new vscode.Position(i + 1, indexOfComment);
                return this.headerCommentStart;
            }
        }

        this.headerCommentStart = this.getTrueStart();
        return this.headerCommentStart;

    }

    private isChildFunctionBetween(child: CSymbol, afterOffset: number, beforeOffset: number): boolean
    {
        if (child.isFunction() && child.isAfter(afterOffset) && child.isBefore(beforeOffset)) {
            return true;
        }
        return false;
    }

    private positionAfterLastChildOrUndefined(): ProposedPosition | undefined
    {
        if (this.children.length > 0) {
            const lastChild = new CSymbol(this.children[this.children.length - 1], this.document);
            return new ProposedPosition(lastChild.range.end, {
                relativeTo: this.children[this.children.length - 1].range,
                after: true
            });
        }
    }

    private matchesPrimitiveType(text: string): boolean
    {
        return text.match(re_primitiveTypes) !== null && text.match(/[<>]/g) === null;
    }
}


/**
 * Represents a new accessor member function for a member variable.
 */
export interface Accessor {
    readonly memberVariable: CSymbol;
    name: string;
    isStatic: boolean;
    returnType: string;
    parameter: string;
    body: string;
    declaration: string;
    definition(target: SourceDocument, position: vscode.Position, newLineCurlyBrace: boolean): Promise<string>;
}

/**
 * Represents a new getter member function for a member variable.
 */
export class Getter implements Accessor
{
    readonly memberVariable: CSymbol;
    name: string;
    isStatic: boolean;
    returnType: string;
    parameter: string;
    body: string;

    constructor(memberVariable: CSymbol)
    {
        const leadingText = memberVariable.leadingText();
        this.memberVariable = memberVariable;
        this.name = memberVariable.getterName();
        const maskedLeadingText = leadingText.replace(re_blockComments, s => ' '.repeat(s.length));
        this.isStatic = maskedLeadingText.match(/\bstatic\b/) !== null;
        if (maskedLeadingText.includes('<')) {
            const templateParamStart = maskedLeadingText.indexOf('<');
            this.returnType = leadingText.substring(0, templateParamStart).replace(/\b(static|const|mutable)\b\s*/g, '')
                    + leadingText.substring(templateParamStart);
        } else {
            this.returnType = leadingText.replace(/\b(static|const|mutable)\b\s*/g, '');
        }
        this.parameter = '';
        this.body = 'return ' + memberVariable.name + ';';
    }

    get declaration(): string
    {
        return (this.isStatic ? 'static ' : '') + this.returnType + this.name + '()' + (this.isStatic ? '' : ' const');
    }

    async definition(target: SourceDocument, position: vscode.Position, newLineCurlyBrace: boolean): Promise<string>
    {
        const eol = target.endOfLine;
        return this.returnType + await this.memberVariable.scopeString(target, position) + this.name + '()'
                + (this.isStatic ? '' : ' const') + (newLineCurlyBrace ? eol : ' ')
                + '{' + eol + util.indentation() + this.body + eol + '}';
    }
}

/**
 * Represents a new setter member function for a member variable.
 */
export class Setter implements Accessor
{
    readonly memberVariable: CSymbol;
    name: string;
    isStatic: boolean;
    returnType: string;
    parameter: string;
    body: string;

    /**
     * This builder method is necessary since CSymbol.isPrimitive() is asynchronous.
     */
    static async create(memberVariable: CSymbol): Promise<Setter>
    {
        const setter = new Setter(memberVariable);
        const leadingText = memberVariable.leadingText();
        const type = leadingText.replace(/\b(static|mutable)\b\s*/g, '');
        setter.isStatic = leadingText.match(/\bstatic\b/) !== null;
        setter.parameter = (!await memberVariable.isPrimitive() && !memberVariable.isPointer()
            ? 'const ' + type + '&'
            : type
        ) + 'value';

        return setter;
    }

    private constructor(memberVariable: CSymbol)
    {
        this.memberVariable = memberVariable;
        this.name = memberVariable.setterName();
        this.isStatic = false;
        this.returnType = 'void ';
        this.parameter = '';
        this.body = memberVariable.name + ' = value;';
    }

    get declaration(): string
    {
        return (this.isStatic ? 'static ' : '') + 'void ' + this.name + '(' + this.parameter + ')';
    }

    async definition(target: SourceDocument, position: vscode.Position, newLineCurlyBrace: boolean): Promise<string>
    {
        const eol = target.endOfLine;
        return this.returnType + await this.memberVariable.scopeString(target, position) + this.name
                + '(' + this.parameter + ')' + (newLineCurlyBrace ? eol : ' ')
                + '{' + eol + util.indentation() + this.body + eol + '}';
    }
}
