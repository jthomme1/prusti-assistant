import * as util from "../util";
import * as vscode from "vscode";
import * as path from "path";
import { PrustiMessageConsumer, parseSpanRange, Message, CargoMessage, dummyRange } from "./message"

function strToRange(rangeStr: string): vscode.Range {
    const arr = JSON.parse(rangeStr) as vscode.Position[];
    return new vscode.Range(arr[0], arr[1]);
}

export class QuantifierChosenTriggersProvider implements vscode.HoverProvider, PrustiMessageConsumer {
    // key1: fileName, key2: stringified range, value: [quantifier string, triggers string]
    private stateMap: Map<string, Map<string, [string, string]>>;
    private hoverRegister: vscode.Disposable;
    private token = "quantifierChosenTriggersMessage";

    public constructor() {
        this.stateMap = new Map<string, Map<string, [string, string]>>();
        this.hoverRegister = vscode.languages.registerHoverProvider('rust', this);
    }

    private getHoverText(document: vscode.TextDocument, position: vscode.Position): string|undefined {
        const rangeMap = this.stateMap.get(document.fileName);
        if (rangeMap === undefined) {
            return undefined;
        }
        const initRange = dummyRange();
        // get the innermost range by iterating over all ranges.
        let matchingRange: vscode.Range = Array.from(rangeMap.keys()).reduce((cur, rangeStr) => {
            const range = strToRange(rangeStr);
            if (range.contains(position) && (cur.contains(range) || cur.isEqual(initRange))) {
                return range;
            } else {
                return cur;
            }
        }, initRange);
        if (matchingRange.isEqual(initRange)) {
            return undefined;
        }
        const rangeStr = JSON.stringify(matchingRange);
        const [quantifier, triggers] = rangeMap.get(rangeStr)!;
        const text = `Viper quantifier: ${quantifier}\nViper triggers: ${triggers}`
        return text;
    }

    public provideHover(document: vscode.TextDocument, position: vscode.Position, _token: vscode.CancellationToken): vscode.Hover|undefined {
        const text = this.getHoverText(document, position);
        if (text === undefined) {
            return undefined;
        }
        const md_text = new vscode.MarkdownString();
        md_text.appendText(text);
        return new vscode.Hover(md_text);
    }

    public update(fileName: string, quantifier: string, triggers: string, range: vscode.Range): void {
        if (!this.stateMap.has(fileName)) {
            const rangeMap = new Map<string, [string, string]>();
            this.stateMap.set(fileName, rangeMap);
        }
        const strRange = JSON.stringify(range);
        const rangeMap = this.stateMap.get(fileName)!;
        rangeMap.set(strRange, [quantifier, triggers]);
    }

    public dispose() {
        this.hoverRegister.dispose();
    }

    public processMessage(msg: Message, isCrate: boolean, rootPath: string): void {
        if (msg.spans.length !== 1) {
            util.log("ERROR: multiple spans for a quantifier.");
        }
        const span = msg.spans[0];
        const range = parseSpanRange(span);
        const fileName = span.file_name;
        const parsedMsg = JSON.parse(msg.message.substring(this.token.length));
        const viperQuant = parsedMsg["viper_quant"];
        const triggers = parsedMsg["triggers"];

        util.log("QuantifierChosenTriggersProvider consumed " + JSON.stringify(msg));
        this.update(isCrate ? path.join(rootPath, fileName) : fileName, viperQuant, triggers, range);
    }

    public processCargoMessage(msg: CargoMessage, isCrate: boolean, rootPath: string): void {
        this.processMessage(msg.message, isCrate, rootPath);
    }
}

export class QuantifierInstantiationsProvider implements vscode.InlayHintsProvider, vscode.HoverProvider, PrustiMessageConsumer {
    // key1: fileName, key2: stringified range, key3: method, value: n_instantiations
    // note: we use the stringified range as identifier because Map uses strict equality "===" to
    // check for key equality, which does not work with newly constructed ranges.
    private stateMap: Map<string, Map<string, Map<string, number>>>;
    // we cache the inlayHints for each file until we get a change
    private inlayCacheMap: Map<string, vscode.InlayHint[]>
    private inlayRegister: vscode.Disposable;
    private hoverRegister: vscode.Disposable;
    private changed: boolean = false;
    private token: string = "quantifierInstantiationsMessage";

    public constructor() {
        this.stateMap = new Map<string, Map<string, Map<string, number>>>();
        this.inlayCacheMap = new Map<string, vscode.InlayHint[]>();
        this.hoverRegister = vscode.languages.registerHoverProvider('rust', this);
        this.inlayRegister = vscode.languages.registerInlayHintsProvider('rust', this);
        setInterval(() => this.reregisterInlayHintsProvider(), 1000);
    }

    private reregisterInlayHintsProvider(): void {
        if (this.changed) {
            this.inlayRegister.dispose();
            this.inlayRegister = vscode.languages.registerInlayHintsProvider('rust', this);
            util.log("Successfully reregistered InlayHintsProvider");
        }
    }

    public provideInlayHints(document: vscode.TextDocument, range: vscode.Range, _token: vscode.CancellationToken): vscode.InlayHint[] {
        // we just ignore the range, vscode ignores hints outside of the requested range
        if (!this.inlayCacheMap.has(document.fileName)) {
            // create the cache map
            if (!this.stateMap.has(document.fileName)) {
                this.inlayCacheMap.set(document.fileName, []);
                return [];
            }
            const rangeMap = this.stateMap.get(document.fileName)!;
            // here we have to sum up the quantifiers pointing to the same range, as this will be
            // the only information given by the inlay hint.
            const hints = Array.from(rangeMap.entries()).map(entry => {
                                                            const pos = strToRange(entry[0]).start;
                                                            const hoverText = this.getHoverText(document, pos);
                                                            const value = "QI: ".concat(Array.from(entry[1].values()).reduce((sum, n) => {return sum + n;}, 0).toString());
                                                            const hint = new vscode.InlayHint(pos, value);
                                                            hint.tooltip = hoverText;
                                                            return hint;
                                                          });
            this.inlayCacheMap.set(document.fileName, hints);
        } else {
            this.changed = false;
        }
        const ret = this.inlayCacheMap.get(document.fileName)!;
        return this.inlayCacheMap.get(document.fileName)!;
    }

    public resolveInlayHint(hint: vscode.InlayHint, _token: vscode.CancellationToken): vscode.InlayHint {
        return hint;
    }

    private getHoverText(document: vscode.TextDocument, position: vscode.Position): string|undefined {
        const rangeMap = this.stateMap.get(document.fileName);
        if (rangeMap === undefined) {
            return undefined;
        }
        const initRange = dummyRange();
        // get the innermost range by iterating over all ranges.
        let matchingRange: vscode.Range = Array.from(rangeMap.keys()).reduce((cur, rangeStr) => {
            const range = strToRange(rangeStr);
            if (range.contains(position) && (cur.contains(range) || cur.isEqual(initRange))) {
                return range;
            } else {
                return cur;
            }
        }, initRange);
        if (matchingRange.isEqual(initRange)) {
            return undefined;
        }
        const rangeStr = JSON.stringify(matchingRange);
        const methodMapEntries = Array.from(rangeMap.get(rangeStr)!.entries());
        const text = methodMapEntries.reduce((str, entry) => {return str.concat(`${entry[0]}: ${entry[1]}, `)}, "Quantifier instantiations per method: ").slice(0, -2);
        return text;
    }

    public provideHover(document: vscode.TextDocument, position: vscode.Position, _token: vscode.CancellationToken): vscode.Hover|undefined {
        const text = this.getHoverText(document, position);
        if (text === undefined) {
            return undefined;
        }
        return new vscode.Hover(text!);
    }

    public update(fileName: string, method: string, instantiations: number, range: vscode.Range): void {
        if (!this.stateMap.has(fileName)) {
            const rangeMap = new Map<string, Map<string, number>>();
            this.stateMap.set(fileName, rangeMap);
        }
        const strRange = JSON.stringify(range);
        const rangeMap = this.stateMap.get(fileName)!;
        if (!rangeMap.has(strRange)) {
            const methodMap = new Map<string, number>();
            rangeMap.set(strRange, methodMap);
        }
        rangeMap.get(strRange)!.set(method, instantiations);
        this.inlayCacheMap.delete(fileName);
        this.changed = true;
    }

    public dispose() {
        this.inlayRegister.dispose();
        this.hoverRegister.dispose();
    }

    public processMessage(msg: Message, isCrate: boolean, rootPath: string): void {
        if (msg.spans.length !== 1) {
            util.log("ERROR: multiple spans for a quantifier.");
        }
        const span = msg.spans[0];
        const range = parseSpanRange(span);
        const fileName = span.file_name;
        const parsedMsg = JSON.parse(msg.message.substring(this.token.length));
        const method = parsedMsg["method"];
        const instantiations = parsedMsg["instantiations"];

        util.log("QuantifierInstantiationsProvider consumed " + JSON.stringify(msg));
        this.update(isCrate ? path.join(rootPath, fileName) : fileName, method, instantiations, range);
    }

    public processCargoMessage(msg: CargoMessage, isCrate: boolean, rootPath: string): void {
        this.processMessage(msg.message, isCrate, rootPath);
    }
}
