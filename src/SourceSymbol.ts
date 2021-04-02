import * as vscode from 'vscode';
import * as util from './utility';
import * as parse from './parsing';


/**
 * Extends DocumentSymbol by adding a parent property and making sure that children are sorted by range.
 * Additionally, some properties are normalized since they vary for different language servers.
 */
export default class SourceSymbol extends vscode.DocumentSymbol {
    readonly uri: vscode.Uri;
    signature: string;
    parent?: SourceSymbol;
    children: SourceSymbol[];

    get location(): vscode.Location { return new vscode.Location(this.uri, this.range); }

    constructor(symbol: vscode.DocumentSymbol, uri: vscode.Uri, parent?: SourceSymbol) {
        super(symbol.name, symbol.detail, symbol.kind, symbol.range, symbol.selectionRange);
        this.uri = uri;

        if (symbol instanceof SourceSymbol) {
            // This was called from CSymbol's constructor, so short-circuit.
            this.signature = symbol.signature;
            this.parent = symbol.parent;
            this.children = symbol.children;
            return;
        }

        this.signature = symbol.name;
        this.parent = parent;

        this.name = parse.getNormalizedSymbolName(symbol.name);

        // ccls puts function signatures in the detail property.
        if (symbol.detail.includes(symbol.name + '(')) {
            this.signature = symbol.detail;
            // ccls recognizes static member functions as properties, so we give it a more appropriate SymbolKind.
            if (symbol.kind === vscode.SymbolKind.Property) {
                this.kind = vscode.SymbolKind.Method;
            }
        } else if (parent?.isClassOrStruct()) {
            this.signature = parent.name + '::' + this.signature;
        }

        // Sort DocumentSymbol.children based on their relative position to eachother.
        symbol.children.sort(util.sortByRange);

        // Convert DocumentSymbol.children to SourceSymbols to set the children property.
        this.children = [];
        symbol.children.forEach(child => this.children.push(new SourceSymbol(child, uri, this)));
    }

    async findDefinition(): Promise<vscode.Location | undefined> {
        return util.findDefinition(this);
    }

    async findDeclaration(): Promise<vscode.Location | undefined> {
        return util.findDeclaration(this);
    }

    /**
     * Returns an array of SourceSymbol's starting with the top-most ancestor and ending with this.parent.
     * Returns an empty array if this is a top-level symbol (parent is undefined).
     */
    scopes(): SourceSymbol[] {
        const scopes: SourceSymbol[] = [];
        let symbol: SourceSymbol = this;
        while (symbol.parent) {
            scopes.push(symbol.parent);
            symbol = symbol.parent;
        }
        return scopes.reverse();
    }

    matches(other: SourceSymbol): boolean {
        return this.name === other.name
            && (this.kind === other.kind || (this.isFunction() && other.isFunction()));
    }

    isMemberVariable(): boolean {
        return this.parent?.isClassOrStruct() === true
                && (this.kind === vscode.SymbolKind.Field || this.kind === vscode.SymbolKind.Property);
    }

    isVariable(): boolean {
        return this.kind === vscode.SymbolKind.Variable || this.isMemberVariable();
    }

    isFunction(): boolean {
        switch (this.kind) {
        case vscode.SymbolKind.Operator:
        case vscode.SymbolKind.Method:
        case vscode.SymbolKind.Constructor:
        case vscode.SymbolKind.Function:
            return true;
        default:
            return false;
        }
    }

    isConstructor(): boolean {
        switch (this.kind) {
        case vscode.SymbolKind.Constructor:
        case vscode.SymbolKind.Method:
        case vscode.SymbolKind.Function:
            return this.name === this.parent?.name || /^(?<name>[\w_][\w\d_]*)::\k<name>/.test(this.signature);
        default:
            return false;
        }
    }

    isDestructor(): boolean {
        switch (this.kind) {
        case vscode.SymbolKind.Constructor:
        case vscode.SymbolKind.Method:
        case vscode.SymbolKind.Function:
            return this.name === '~' + this.parent?.name || /^(?<name>[\w_][\w\d_]*)::~\k<name>/.test(this.signature);
        default:
            return false;
        }
    }

    isClassOrStruct(): boolean {
        return this.kind === vscode.SymbolKind.Class || this.kind === vscode.SymbolKind.Struct;
    }

    /**
     * This is a fuzzy test to see if the symbol might be a typedef or type-alias. This tells us that it
     * is worth it to open the document cooresponding to this.uri to resolve the typedef/type-alias.
     */
    mightBeTypedefOrTypeAlias(): boolean {
        return this.kind === vscode.SymbolKind.Interface    // cpptools
            || this.kind === vscode.SymbolKind.Class        // clangd
            || this.kind === vscode.SymbolKind.Property;    // ccls
    }

    /**
     * Checks for common naming schemes of private members and returns the base name.
     */
    baseName(): string {
        if (/^_+|_+$/.test(this.name)) {
            return this.name.replace(/^_+|_+$/g, '');
        }

        if (/^m_[\w_][\w\d_]*$/.test(this.name)) {
            return this.name.replace(/^m_/, '');
        }

        if (/^s_[\w_][\w\d_]*$/.test(this.name)) {
            return this.name.replace(/^s_/, '');
        }

        return this.name;
    }

    memberVariables(): SourceSymbol[] {
        if (!this.isClassOrStruct()) {
            return [];
        }

        return this.children.filter(child => child.isMemberVariable());
    }

    constructors(): SourceSymbol[] {
        if (!this.isClassOrStruct()) {
            return [];
        }

        return this.children.filter(child => child.isConstructor());
    }
}
