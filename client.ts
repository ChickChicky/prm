'use strict';

// TODO: Probably rename
// * SourceProvider  -> Source
// * SourceProviderT -> SourceProvider

import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import util = require('node:util');
import json5 = require('json5');

const STATE_PATH = path.join(__dirname, 'prm.json5');
const DEFAULT_STATE = `{ // auto-genrated configuration file
    lastSource: null,
}`;

function loadLocalState() {
    if (!fs.existsSync(STATE_PATH)) {
        fs.writeFileSync(STATE_PATH, DEFAULT_STATE);
        localState = json5.parse(DEFAULT_STATE);
    }
    else {
        localState = json5.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    }
}

function saveLocalState() {
    fs.writeFileSync(STATE_PATH, json5.stringify(localState, {space:4}), 'utf-8');
}

var localState: {
    lastSource?: string;
};

loadLocalState();

const fastHash = (str: crypto.BinaryLike) => crypto.createHash('sha1').update(str).digest('base64');
const vlen = (str: string) => util.stripVTControlCharacters(str).length;

const [sin,sout] = [process.stdin,process.stdout];

const DATA_DIR = path.join(__dirname, 'sources');

type SourceOptionValue<T> = 
    T extends readonly [infer I] ?
        SourceOptionValue<I>[]
    : T extends 'number' ?
        number
    : T extends 'string' ?
        string
    : T extends 'boolean' ?
        boolean
    : T extends RegExp ?
        string
    : T extends RangeConstraint ?
        number
    : T extends object ?
        { -readonly [K in keyof T]: SourceOptionValue<T[K]> }
    : never
;
type OT<T> = T extends undefined ? undefined : SourceOptionValue<T>;
type NewOptions<T extends (..._:any)=>any> = OT<ReturnType<T>>;
type SourceOptionDesc = 
    { [k: string]: SourceOptionDesc }
    | [SourceOptionDesc]
    | 'string'
    | RegExp
    | 'number'
    | RangeConstraint
    | 'boolean'
;

type File = {
    name: string;
};

type ProjectPartial = {
    id: string;
    name: string;
};

type Project = ProjectPartial & {
    files?: File[];
};

type SourceProviderT = typeof SourceProvider;
class SourceProvider {
    sourceId: string;
    options: any;

    constructor (sourceId: string, options: any) {
        this.sourceId = sourceId;
        this.options = options;
    }

    listProjects(): ProjectPartial[] {
        throw new TypeError('list called on base SourceProviders');
    }

    getProject(projectId: string): Project|undefined {
        throw new TypeError('getProject called on base SourceProviders');
    }

    static fromId<T extends typeof SourceProvider>(this: T, sourceId: string, options: any): InstanceType<T> | undefined {
        const provider = getSourceProvider(sourceId);
        if (!provider) return undefined;
        return new provider(sourceId, options) as InstanceType<T>;
    }

    static getNewOptions(): any {
        throw new TypeError('getNewOptions called on base SourceProvider');
    }

    static newSource(meta: SourceMeta, options: any): void {
        throw new TypeError('newSource called on base SourceProvider');
    }
}

const sourceProviders: { [k: string]: SourceProviderT } = {};
const sourceProviderIndicators: { [k: string]: string } = {};

function registerSourceProvider(provider: SourceProviderT, id: string, indicator?: string): void {
    sourceProviders[id] = provider;
    if (indicator)
        sourceProviderIndicators[id] = indicator;
}

function getSourceProviderId(sourceProvider: SourceProviderT): string | undefined {
    for (const [id,provider] of Object.entries(sourceProviders)) {
        if (provider == sourceProvider)
            return id;
    }
    return undefined;
}

function getSourceProvider(id: string): SourceProviderT | undefined {
    return sourceProviders[id];
}

function getSourceProviderIndicator(id: string): string {
    return sourceProviderIndicators[id] || '?';
}

class RangeConstraint {
    min: number;
    max: number;
    constructor (min: number, max: number) {
        this.min = min;
        this.max = max;
    }
}

type LocalSourceProviderOptions = NewOptions<typeof LocalSourceProvider.getNewOptions>;
class LocalSourceProvider extends SourceProvider {
    options: LocalSourceProviderOptions;

    constructor (sourceId: string, options: LocalSourceProviderOptions) {
        super(sourceId, options);
    }

    listProjects(): ProjectPartial[] {
        const proj_dir = path.join(DATA_DIR, this.sourceId, 'projects');
        return fs.readdirSync(proj_dir)
            .filter( d => fs.statSync(path.join(proj_dir, d)).isDirectory() )
            .map( d => ({id: d, name: d}) )
        ;
    }

    getProject(projectId: string): Project|undefined {
        return undefined;
    }

    static getNewOptions() {
        return {
            a: 'string'
        } as const;
    }
}
registerSourceProvider(LocalSourceProvider, 'local', 'L');

type SourceMeta = {
    name: string;
    provider: string;
    providerData?: any;
};

function isSourceMetadata(o: any): o is SourceMeta {
    return (
        typeof o.name == 'string' &&
        typeof o.provider == 'string'
    );
}

function generateId(): string {
    return Date.now().toString(36) + Math.floor(Math.random()*46655).toString(36).padStart(3,'0');
}

function sourceExists(id: string): boolean {
    return fs.existsSync(path.join(DATA_DIR, id));
}

function generateNewSourceId(): string {
    let id = generateId();
    while (sourceExists(id))
        id = generateId();
    return id;
}

function newSource<T extends SourceProviderT>(name: string, provider: T, options: NewOptions<T['getNewOptions']>): void {
    const id = generateNewSourceId();
    fs.mkdirSync(path.join(DATA_DIR, id));
    fs.mkdirSync(path.join(DATA_DIR, id, 'projects'));
    const providerId = getSourceProviderId(provider);
    if (!providerId)
        throw new TypeError('Could not find provider id');
    const meta: SourceMeta = {
        name,
        provider: providerId,
    };
    provider.newSource(meta, options);
    fs.writeFileSync(path.join(DATA_DIR, id, 'source.json5'), json5.stringify(meta, {space:2}));
}

function loadSource(id: string) {
    const meta = json5.parse(fs.readFileSync(path.join(DATA_DIR, id, 'source.json5'), 'utf-8'));
    if (!isSourceMetadata(meta))
        throw new TypeError('Bad source metadata');
}

function getSourceMeta(id: string): any {
    return json5.parse(fs.readFileSync(path.join(DATA_DIR, id, 'source.json5'), 'utf-8'));
}

type SourceInfo = {
    id: string,
    meta: SourceMeta
};
function getSources(): SourceInfo[] {
    const sources: SourceInfo[] = [];
    try {
        for (const id of fs.readdirSync(path.join(DATA_DIR))) {
            if (!fs.existsSync(path.join(DATA_DIR, id, 'source.json5')))
                continue;
            const meta = getSourceMeta(id);
            if (!isSourceMetadata(meta))
                continue;
            sources.push({id, meta});
        }
    } catch (e) {
        errorEx(e);
    }
    return sources;
}

const THEME_VARIANT_1:  ThemeVariant = 0;
const THEME_VARIANT_4:  ThemeVariant = 1;
const THEME_VARIANT_8:  ThemeVariant = 2;
const THEME_VARIANT_24: ThemeVariant = 3;

interface Style {
    fg(other: Style): Style;
    bg(other: Style): Style;
    enable(): string;
    disable(): string;
};

// TOOD: Refactor {f,g}c{4,8,24} into a Color class
const _ss: Style = {
    fg(other: Style) {
        if ('fc4' in other)
            return Object.setPrototypeOf({...this,fc4:other.fc4},Object.getPrototypeOf(this));
        if ('fc8' in other)
            return Object.setPrototypeOf({...this,fc8:other.fc8},Object.getPrototypeOf(this));
        if ('fc24' in other)
            return Object.setPrototypeOf({...this,fc24:other.fc24},Object.getPrototypeOf(this));
    },
    bg(other: Style) {
        if ('gc4' in other)
            return Object.setPrototypeOf({...this,fc4:other.gc4},Object.getPrototypeOf(this));
        if ('gc8' in other)
            return Object.setPrototypeOf({...this,fc8:other.gc8},Object.getPrototypeOf(this));
        if ('gc24' in other)
            return Object.setPrototypeOf({...this,fc24:other.gc24},Object.getPrototypeOf(this));
    },
    enable() {
        let s: string[] = [];
        if ('fc4' in this) s.push(`${30+(this.fc4>7?60:0)+(this.fc4%8)}`);
        if ('fc8' in this) s.push(`38;5;${this.fc8}`);
        if ('fc24' in this) s.push(`38;2;${this.fc24.r};${this.fc24.g};${this.fc24.b}`);
        if ('bc4' in this) s.push(`${30+(this.bc4>7?60:0)+(this.bc4%8)}`);
        if ('bc8' in this) s.push(`38;5;${this.bc8}`);
        if ('bc24' in this) s.push(`38;2;${this.bc24.r};${this.bc24.g};${this.bc24.b}`);
        if (this.bold) s.push('1');
        if (this.faint) s.push('2');
        if (this.italic) s.push('3');
        if (this.underline) s.push('4');
        if (this.blink) s.push('5');
        if (this.reverse) s.push('7');
        if (this.strike) s.push('9');
        return `${s.length?`\x1b[${s.join(';')}m`:''}`;
    },
    disable() {
        return '\x1b[m';
        let s: string[] = [];
        if ('fc4' in this || 'fc8' in this || 'fc24' in this) s.push('39');
        if ('bc4' in this || 'bc8' in this || 'bc24' in this) s.push('49');
        if (this.bold || this.faint) s.push('22');
        if (this.italic) s.push('23');
        if (this.underline) s.push('24');
        if (this.blink) s.push('25');
        if (this.reverse) s.push('27');
        if (this.strike) s.push('29');
        return `${s.length?`\x1b[${s.join(';')}m`:''}`;
    }
};

function C4(c: number): Style {return Object.setPrototypeOf({fc4:c},_ss);}
function C8(c: number): Style {return Object.setPrototypeOf({fc8:c},_ss);}
function C24(r: number, g: number, b: number): Style {return Object.setPrototypeOf({fc24:{r,g,b}},_ss);}
function C4b(c: number): Style {return Object.setPrototypeOf({bc4:c},_ss);}
function C8b(c: number): Style {return Object.setPrototypeOf({bc8:c},_ss);}
function C24b(r: number, g: number, b: number): Style {return Object.setPrototypeOf({bc24:{r,g,b}},_ss);}
function SR() {return Object.setPrototypeOf({reverse:true,bold:true},_ss);}
function S() {return Object.setPrototypeOf({},_ss);}

const BLACK   = C4(0);
const RED     = C4(1);
const GREEN   = C4(2);
const YELLOW  = C4(3);
const BLUE    = C4(4);
const MAGENTA = C4(5);
const CYAN    = C4(6);
const WHITE   = C4(7);
const BRIGHTBLACK   = C4(8);
const BRIGHTRED     = C4(9);
const BRIGHTGREEN   = C4(10);
const BRIGHTYELLOW  = C4(11);
const BRIGHTBLUE    = C4(12);
const BRIGHTMAGENTA = C4(13);
const BRIGHTCYAN    = C4(14);
const BRIGHTWHITE   = C4(15);

type ThemeVariant = 0 | 1 | 2 | 3;
type ThemeColor = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite';
type TermColor = [Style, Style, Style];
const baseColors: {[k in ThemeColor]:TermColor} = {
    black: [BLACK, BLACK, BLACK],
    red: [RED, RED, RED],
    green: [GREEN, GREEN, GREEN],
    yellow: [YELLOW, YELLOW, YELLOW],
    blue: [BLUE, BLUE, BLUE],
    magenta: [MAGENTA, MAGENTA, MAGENTA],
    cyan: [CYAN, CYAN, CYAN],
    white: [WHITE, WHITE, WHITE],
    brightBlack: [BRIGHTBLACK, BRIGHTBLACK, BRIGHTBLACK],
    brightRed: [BRIGHTRED, BRIGHTRED, BRIGHTRED],
    brightGreen: [BRIGHTGREEN, BRIGHTGREEN, BRIGHTGREEN],
    brightYellow: [BRIGHTYELLOW, BRIGHTYELLOW, BRIGHTYELLOW],
    brightBlue: [BRIGHTBLUE, BRIGHTBLUE, BRIGHTBLUE],
    brightMagenta: [BRIGHTMAGENTA, BRIGHTMAGENTA, BRIGHTMAGENTA],
    brightCyan: [BRIGHTCYAN, BRIGHTCYAN, BRIGHTCYAN],
    brightWhite: [BRIGHTWHITE, BRIGHTWHITE, BRIGHTWHITE],
};

const renderers = {
    sg : {
        buff: '',
        scroll: {} as {[k:string]:number},
        scrollUpdate: [] as string[],
        reset() {
            this.buff = '';
        },
        clear() {
            this.buff += '\x1B[H\x1B[J';
        },
        banner( title: string, style: Style = SR() ) {
            this.buff += `\x1b[H${style.enable()}${title.padStart(Math.floor(sout.columns/2+vlen(title)/2)).padEnd(sout.columns)}${style.disable()}`;
        },
        // TODO: scrolling banner
        label( label: string, style: Style, x: number, y: number ) {
            this.buff += `\x1b[${y+1};${x+1}H${style.enable()}${label}${style.disable()}`;
        },
        scrollingLabel( label: string, id: string, style: Style, x: number, y: number, maxWidth?: number, sep: string = ' · ' ) {
            this.scrollUpdate.push(id);
            if (!(id in this.scroll))
                this.scroll[id] = Date.now();
            const mx = Math.min(maxWidth ? x+maxWidth : Infinity, sout.columns);
            const w = mx-x;
            if (w >= label.length) {
                this.scroll[id] = Date.now();
                this.label(label, style, x, y);
            } else {
                const i = Math.floor((Date.now()-this.scroll[id])/(300-Math.log(label.length+1)*30))%(label.length+sep.length);
                const l = label + sep + label.slice(0,w);
                this.label(l.slice(i,i+w), style, x, y);
            }
        },
        centeredLabel( label: string, style: Style, y: number, span: [number,number] = [0, sout.columns-1]) {
            const [xa, xb] = span;
            this.label(label, style, xa + (xb-xa)/2 - label.length/2, y);
        },
        goTo( x: number, y: number ) {
            this.buff += `\x1b[${y+1};${x+1}H`;  
        },
        flush() {
            const scroll = {};
            for (const k of this.scrollUpdate)
                scroll[k] = this.scroll[k];
            this.scroll = scroll;
            this.scrollUpdate = [];
            process.stdout.write(this.buff);
            this.reset();
        }
    }
};

const { sg } = renderers;

type InputKind = 'key' | 'text';
interface State {
    init(): void;
    enter(data?: any): void;
    exit(data?: any): void;
    render(): void;
    input(input: string, kind: InputKind): void;
}

type KeyKind = 
    'unknown' 
    | 'escape' | 'delete' | 'insert' | 'home' | 'end' | 'backspace'
    | 'up' | 'down' | 'left' | 'right'
    | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'
    | 'f0' | 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12' | 'f13' | 'f14' | 'f15' | 'f16' | 'f17' | 'f18' | 'f19' | 'f20'
;
type Key = {
    kind: KeyKind;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
};

function applyEncodedMods(k: Key, mod: number) {
    /* 000 1 */ if (mod == 1) k.meta = true;
    /* 100 0 */ if (mod == 2) k.shift = true;
    /* 010 0 */ if (mod == 3) k.alt = true;
    /* 110 0 */ if (mod == 4) k.alt = k.shift = true;
    /* 001 0 */ if (mod == 5) k.ctrl = true;
    /* 101 0 */ if (mod == 6) k.ctrl = k.shift = true;
    /* 011 0 */ if (mod == 7) k.ctrl = k.alt = true;
    /* 111 0 */ if (mod == 8) k.ctrl = k.alt = k.shift = true;
}

function parseKey(input: string) : Key {
    const k: Key = {
        kind: 'unknown',
        ctrl: false,
        shift: false,
        alt: false,
        meta: false
    };
    const i = input.codePointAt(0);
    if (input.length == 1 && i && i >= 1 && i <= 26) {
        k.kind = String.fromCodePoint(i+0x60) as KeyKind;
        k.ctrl = true;
    }
    else if (input == '\x7F') {
        k.kind = 'backspace';
    }
    else if (/^[a-z]$/.test(input))
        k.kind = input as KeyKind;
    else if (/^[A-Z]$/.test(input)) {
        k.kind = input.toLowerCase() as KeyKind;
        k.shift = true;
    }
    else if (input == '\x1B')
        k.kind = 'escape';
    else if (/^\x1B\[((\d+;)+)?(\d+)?[\x40-\x7E]$/.test(input)) {
        const chr = input.at(-1);
        const [val, mod] = input.slice(2,-1).split(';').map(v=>+v);
        if (mod && !Number.isNaN(mod))
            applyEncodedMods(k, mod);
        if (chr == '~' && val && !Number.isNaN(val)) {
            if (val ==  2) k.kind = 'insert'
            if (val ==  3) k.kind = 'delete';
            if (val == 10) k.kind = 'f0';
            if (val == 11) k.kind = 'f1';
            if (val == 12) k.kind = 'f2';
            if (val == 13) k.kind = 'f3';
            if (val == 14) k.kind = 'f4';
            if (val == 15) k.kind = 'f5';
            if (val == 17) k.kind = 'f6';
            if (val == 18) k.kind = 'f7';
            if (val == 19) k.kind = 'f8';
            if (val == 20) k.kind = 'f9';
            if (val == 21) k.kind = 'f10';
            if (val == 22) k.kind = 'f11';
            if (val == 24) k.kind = 'f12';
            if (val == 25) k.kind = 'f13';
            if (val == 26) k.kind = 'f14';
            if (val == 28) k.kind = 'f15';
            if (val == 29) k.kind = 'f16';
            if (val == 31) k.kind = 'f17';
            if (val == 32) k.kind = 'f18';
            if (val == 33) k.kind = 'f19';
            if (val == 34) k.kind = 'f20';
        }
        if (chr == 'A') k.kind = 'up';
        if (chr == 'B') k.kind = 'down';
        if (chr == 'C') k.kind = 'right';
        if (chr == 'D') k.kind = 'left';
    }
    else if (/^\x1b[\x40-\x7F]$/.test(input)) {
        k.alt = true;
        if (input[1] == '\x7F') {
            k.kind = 'backspace';
        } else {
            k.kind = input[1].toLowerCase() as KeyKind;
            k.shift = input[1] != k.kind;
        }
    }
    return k;
}

const CTRL = 1;
const SHIFT = 2;
const ALT = 4;
const META = 8; 

function encodeMod(key: Key): number {
    return (+key.ctrl) | (+key.shift<<1) | (+key.alt<<2) | (+key.meta<<3);
}

function MOD(m: number, n: number): number {
    return ((m+n)%n)%n;
}

function MIX(a: number, b: number, t: number) {
    return a + (b-a)*t;
}

function singleCharProgress(t: number): string {
    const steps = '⠁⠃⠇⡇⣇⣧⣷⣿⣿';
    return steps[Math.floor(Math.max(0,Math.min(1,t))*(steps.length-1))];
}

const TOAST_ERROR = Symbol('TOAST_ERROR');
type Toast = { message: string, time: number, icon?: string | typeof TOAST_ERROR };

class MainMenuState implements State {
    sources: SourceInfo[];
    selected: number;
    toasts: Toast[];
    toastRef: number;
    location: string[];
    rootLocations: string[] = ['sources'];

    formatLocation() {
        return '/'+this.location.join('/')+(this.location.length?'/':'');
    }
    
    init() {
        this.sources = [];
        this.selected = 0;
        this.toasts = [];
        this.toastRef = 0;
        this.location = [];
    }

    enter(data?: any): void {
        this.sources = getSources();
        this.selected = 0;
        this.toastRef = 0;
        this.toasts = [];
    }

    exit(data?: any): void {
        
    }

    render(): void {
        sg.reset();
        sg.clear();
        sg.banner('Home');
        const location: string[] = [...this.location];
        const section = location.shift();
        if (!section) {
            for (let i = 0; i < this.rootLocations.length; i++) {
                sg.centeredLabel(this.rootLocations[i], this.selected==i?SR():S(), i+2);
            }
        }
        else if (section == 'sources') {
            const sub = location.shift();
            if (!sub) {
                for (let i = 0; i < this.sources.length; i++) {
                    const source: SourceInfo = this.sources[i];
                    sg.label(getSourceProviderIndicator(source.meta.provider), S(), 0, i+2);
                    sg.label(source.meta.name, i==this.selected?SR():S(), 2, i+2);
                }
                sg.label('+', S(), 0, this.sources.length+2);
                sg.label('new', (this.sources.length==this.selected?SR():S()).fg(BRIGHTCYAN), 2, this.sources.length+2);
            } else
                this.location.pop();
        }
        else {
            this.location = [];
        }
        const toast = this.toasts[0];
        if (toast) {
            if (!this.toastRef)
                this.toastRef = Date.now();
            const nToasts = this.toasts.length;
            const off = nToasts.toString().length+3;
            const [icon, iconStyle] = (
                toast.icon ?
                    typeof toast.icon == 'string' ?
                        [toast.icon, S()]
                    : typeof toast.icon == 'symbol' ?
                        {
                            [TOAST_ERROR]: ['X', RED]
                        }[toast.icon]
                    : [undefined, undefined]
                : [undefined, undefined]
            ) as [string, Style] | [undefined, undefined];
            const tt =  MIX(toast.time, 1000, 1-1/(this.toasts.length/2+1)) + (this.toasts.length == 1 ? 60e3 : 0);
            const ta = Date.now();
            const tb = this.toastRef + tt;
            sg.label(`${singleCharProgress(1-(tt-(Date.now()-this.toastRef))/tt)} ${nToasts} `, S(), 0, sout.rows-1);
            if (icon)
                sg.label(icon, iconStyle, off,sout.rows-1);
            sg.scrollingLabel(toast.message, fastHash(toast.message), S(), off+(icon?2:0), sout.rows-1);
            if (ta >= tb || this.toasts.length > 60) {
                this.toasts.shift();
                this.toastRef = this.toasts.length ? Date.now() : 0;
            }
        }
        const loc = this.formatLocation();
        sg.scrollingLabel(loc, 'mainMenu.path', S(), 0, 1);
        // sg.goTo((this.sources[this.selected]?.meta?.name?.length||3)+2, this.selected+2);
        sg.goTo(loc.length, 1);
        sg.flush();
    }

    input(input: string, kind: InputKind) {
        if (kind == 'key') {
            const info = parseKey(input);
            const { kind: key, ctrl, shift, alt, meta } = info;
            const mod = encodeMod(info);
            if (key == 'c' && mod == CTRL)
                close();
            const location: string[] = [...this.location];
            const section = location.shift();
            if (!section) {
                if (key == 'backspace' && !mod)
                    close();
                if (key == 'up' && !mod)
                    this.selected = MOD(this.selected-1,this.rootLocations.length);
                if (key == 'down' && !mod)
                    this.selected = MOD(this.selected+1,this.rootLocations.length);
            }
            else section_handler: {
                if (key == 'backspace' && !mod) {
                    this.location.pop();
                    break section_handler;
                }
                if (section == 'sources') {
                    const sub = location.shift();
                    if (!sub) {
                        if (key == 'up' && !mod)
                            this.selected = MOD(this.selected-1,this.sources.length+1);
                        if (key == 'down' && !mod)
                            this.selected = MOD(this.selected+1,this.sources.length+1);
                    }
                    else if (sub == 'new') {

                    }
                }
            }
        }
        if (kind == 'text') {
            if (input == '\r') {
                try {
                    const location: string[] = [...this.location];
                    const section = location.shift();
                    if (!section) {
                        this.location = [this.rootLocations[this.selected]];
                    } 
                    else {
                        if (section == 'sources') {
                            const sub = location.shift();
                            if (!sub) {
                                if (this.selected == this.sources.length) {
                                    // TODO: Implement Source UI
                                    throw new Error('Not implemented :p');
                                    this.location.push('new');
                                }
                                else {
                                    const info = this.sources[this.selected] as SourceInfo;
                                    if (!info)
                                        throw new Error('Invalid source');
                                    if (!info.id || !fs.existsSync(path.join(DATA_DIR, info.id)))
                                        throw new Error('Invalid source ID');
                                    const provider = getSourceProvider(info.meta.provider);
                                    if (!provider)
                                        throw new Error('Unknown provider');
                                    const source = new provider(info.id, info.meta.providerData);
                                    switchTo('source', {source, meta: info.meta});
                                }
                            }
                            else if (sub == 'new') {

                            }
                        }
                    }
                } catch (e) {
                    errorEx(e);
                    this.toasts.push({message:e.toString(),time:5000,icon:TOAST_ERROR});
                    sout.write('\x07');
                }
            }
        }
    }
}

class SourceState implements State {
    source: SourceProvider;
    meta: SourceMeta;
    projects: ProjectPartial[];
    loadedProject?: Project;
    selected: number;

    init(): void {
        
    }

    enter(data?: any): void {
        const source = data?.source;
        if (!(source instanceof SourceProvider))
            throw new Error('Bad source');
        const meta = data?.meta;
        if (!isSourceMetadata(meta))
            throw new Error('Bad metatata');
        this.source = source;
        this.meta = meta;
        if (localState.lastSource != source.sourceId) {
            localState.lastSource = source.sourceId;
            saveLocalState();
        }
        this.projects = source.listProjects().concat([null]);
        this.selected = 0;
    }

    exit(data?: any): void {
        
    }

    render(): void {
        sg.reset();
        sg.clear();
        sg.banner(this.meta.name);
        if (!this.loadedProject) {
            for (let i = 0; i < this.projects.length; i++) {
                const project = this.projects[i];
                const s = this.selected==i?SR():S();
                if (project == null)
                    sg.label('new', s.fg(BRIGHTCYAN), 0, i+1);
                else
                    sg.scrollingLabel(project.name, project.id, s, 0, i+1);
            }
        }
        else {

        }
        sg.goTo((this.projects[this.selected]?.name.length||3), this.selected+1);
        sg.flush();
    }

    input(input: string, kind: InputKind): void {
        if (kind == 'key') {
            const info = parseKey(input);
            const { kind: key, ctrl, shift, alt, meta } = info;
            const mod = encodeMod(info);
            if (key == 'c' && mod == CTRL)
                close();
            if (key == 'backspace' && !mod)
                switchTo('mainMenu');
            if (!this.loadedProject) {
                if (key == 'up' && !mod)
                    this.selected = MOD(this.selected-1,this.projects.length);
                if (key == 'down' && !mod)
                    this.selected = MOD(this.selected+1,this.projects.length);
            }
            else {

            }
        }
        if (kind == 'text') {
            if (!this.loadedProject) {

            }
            else {

            }
        }
    }
}

type KState = 'mainMenu' | 'source';
const states : { [k in KState]: State } = {
    'mainMenu':  new MainMenuState(),
    'source': new SourceState(),
};

function switchTo(newState: KState, enterData?: any, exitData?: any) {
    const oldState = getState();
    if (oldState)
        oldState.exit(exitData);
    const state = states[newState];
    state.enter(enterData);
    currentState = newState;
}

function switchToDirty(newState: KState) {
    currentState = newState;
}

function getState(): State | undefined {
    return states[currentState];
}

function close() {
    running = false;
}

function setThemeVariant(variant?: ThemeVariant): ThemeVariant {
    const v = themeVariant;
    if (variant != undefined)
        themeVariant = variant;
    return v;
}

function autoDetectThemeVariant() {
    const depth = sout.getColorDepth();
    if (depth == 1) themeVariant = THEME_VARIANT_1;
    else if (depth == 4) themeVariant = THEME_VARIANT_4;
    else if (depth == 8) themeVariant = THEME_VARIANT_8;
    else if (depth == 24) themeVariant = THEME_VARIANT_24;
    else themeVariant = THEME_VARIANT_1;
}

let running = true;
let currentState: KState;
let themeVariant: ThemeVariant = 0;

function logEx(...data) {
    sout.write('\x1b[?1049l');
    console.log(...data);
    sout.write('\x1b[?1049h');
}

function errorEx(...data) {
    sout.write('\x1b[?1049l');
    console.error(...data);
    sout.write('\x1b[?1049h');
}

function restoreState(): boolean {
    try {
        if (!localState.lastSource)
            return false;
        if (!sourceExists(localState.lastSource)) {
            localState.lastSource = null;
            saveLocalState();
            return false;
        }
        const meta = getSourceMeta(localState.lastSource);
        const provider = getSourceProvider(meta.provider);
        if (!provider)
            return false;
        const source = new provider(localState.lastSource, meta.providerData);
        switchTo('source', {source, meta});
        return true;
    } catch (e) {
        errorEx('Failed to restore state:');
        errorEx(e);
    }
}

;(async()=>{

    for (const state of Object.values(states))
        state.init();

    if (!restoreState())
        switchTo('mainMenu');
    
    sout.write('\x1b[?1049h\x1b[H\x1b[2 q');
    process.title = 'PRM';
    sin.setRawMode(true);
    sin.ref();

    autoDetectThemeVariant();
    setImmediate(autoDetectThemeVariant);

    function render() {
        getState()?.render();
    }

    sin.on('data', data => {
        let evts: [string,InputKind][] = [];

        let buff = '';
        function clbuff() {
            if (!buff.length) return;
            evts.push([buff,'text']);
            buff = '';
        }
        for (let i = 0; i < data.length; i++) {
            const c = data[i];
            if (c <= 0x1F) {
                if (c == 0x1B) {
                    clbuff();
                    let b = '\x1B';
                    const m = i+1;
                    while (++i < data.length) {
                        const k = data[i]; const j = i-m;
                        if (j == 0) {
                            const isSequence = k == 0x5B || k == 0x5D;
                            const isAlt = k >= 0x40 && k <= 0x7F && !isSequence;
                            if (!isSequence && !isAlt) {
                                buff += String.fromCodePoint(k);
                                break;
                            }
                            b += String.fromCodePoint(k);
                            // TODO: handle https://en.wikipedia.org/wiki/ANSI_escape_code#Fe_Escape_sequences
                            if (isAlt)
                                break;
                        }
                        else {
                            b += String.fromCodePoint(k);
                            if (k >= 0x40 && k <= 0x7E)
                                break;
                        }
                    }
                    evts.push([b,'key']);
                    clbuff();
                }
                else if (c == 0x0A || c == 0x0D) {
                    buff += '\r';
                }
                else {
                    clbuff();
                    evts.push([String.fromCodePoint(c),'key']);
                }
            }
            else if (c == 0x7F) {
                evts.push([String.fromCodePoint(c),'key']);
            }
            else {
                buff += String.fromCodePoint(c);
            }
        }
        clbuff();

        const state = getState();
        if (state) {
            for (const [seq, kind] of evts)
                state.input(seq, kind);
        }

        render();
    });

    sout.on('resize', render);
    
    while (running) {
        await new Promise(r=>setTimeout(r,50));
        if (!getState()) {
            running = false;
            break;
        }
        render();
    }
    
    getState()?.exit();

})().finally(()=>{
    sin.unref();
    sin.setRawMode(false);
    sout.write('\x1b[1 q\x1b[?1049l');
});
