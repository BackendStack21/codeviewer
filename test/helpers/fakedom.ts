// Minimal fake DOM for testing browser-side modules without any dependency.
// Implements only what src/client modules use. Install with installDom(), undo with uninstallDom().

type Listener = (e: FakeEvent) => void;

export class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  target: unknown = null;
  [k: string]: unknown;
  constructor(public type: string, init: Record<string, unknown> = {}) {
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
}

class Target {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener, _opts?: unknown) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener, _opts?: unknown) {
    this.listeners.get(type)?.delete(fn);
  }
  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
  protected fire(e: FakeEvent) {
    for (const fn of [...(this.listeners.get(e.type) ?? [])]) fn(e);
  }
  dispatchEvent(e: FakeEvent) {
    if (!e.target) e.target = this;
    this.fire(e);
    return !e.defaultPrevented;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class FakeText {
  parent: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
}

type Sel = { tag?: string; classes: string[]; attr?: string };
function parseSel(s: string): Sel {
  const m = /^([a-z0-9]*)((?:\.[\w-]+)*)(?:\[([\w-]+)\])?$/i.exec(s.trim());
  if (!m) throw new Error("fakedom: unsupported selector " + s);
  return { tag: m[1] || undefined, classes: m[2] ? m[2].split(".").slice(1) : [], attr: m[3] };
}

export class FakeElement extends Target {
  parent: FakeElement | null = null;
  children: (FakeElement | FakeText)[] = [];
  attrs = new Map<string, string>();
  /** Plain property bag; setProperty is non-enumerable so an untouched style has no keys. */
  style: Record<string, string> & { setProperty(k: string, v: string): void } = Object.defineProperty({} as Record<string, string>, "setProperty", {
    value(this: Record<string, string>, k: string, v: string) {
      this[k] = v;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  }) as Record<string, string> & { setProperty(k: string, v: string): void };
  tagName: string;
  value = "";
  placeholder = "";
  disabled = false;
  title = "";
  private _html: string | null = null;
  focused = false;
  scrolled = 0;
  /** Like a browser, emptying the element clamps scrollTop to 0 (see replaceChildren). */
  scrollTop = 0;
  rect = { width: 100, height: 40, left: 0, top: 0 };

  constructor(public tag: string, private doc: FakeDocument) {
    super();
    this.tagName = tag.toUpperCase();
  }

  get className() {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean);
    const set = (a: string[]) => (this.className = a.join(" "));
    return {
      add: (...c: string[]) => set([...new Set([...get(), ...c])]),
      remove: (...c: string[]) => set(get().filter((x) => !c.includes(x))),
      contains: (c: string) => get().includes(c),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !get().includes(c);
        if (on) this.classList.add(c);
        else this.classList.remove(c);
        return on;
      },
    };
  }
  get hidden() {
    return this.attrs.has("hidden");
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set("hidden", "");
    else this.attrs.delete("hidden");
  }
  get id() {
    return this.attrs.get("id") ?? "";
  }
  get dataset() {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) if (k.startsWith("data-")) out[k.slice(5)] = v;
    return out;
  }
  get isConnected(): boolean {
    let n: FakeElement | null = this;
    while (n) {
      if (n === this.doc.documentElement) return true;
      n = n.parent;
    }
    return false;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
    if (k === "title") this.title = String(v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }

  private adopt(c: FakeElement | FakeText | string) {
    const n = typeof c === "string" ? new FakeText(c) : c;
    if (n.parent) n.parent.children = n.parent.children.filter((x) => x !== n);
    n.parent = this;
    return n;
  }
  append(...cs: (FakeElement | FakeText | string)[]) {
    this._html = null;
    for (const c of cs) this.children.push(this.adopt(c));
  }
  appendChild<T extends FakeElement>(c: T) {
    this.append(c);
    return c;
  }
  replaceChildren(...cs: (FakeElement | FakeText | string)[]) {
    this._html = null;
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.scrollTop = 0;
    this.append(...cs);
  }
  remove() {
    // Like a browser: removing the focused element (or its ancestor) drops focus to <body>.
    if (this.contains(this.doc.activeElement)) {
      this.doc.activeElement!.focused = false;
      this.doc.activeElement = this.doc.body;
    }
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
  contains(n: unknown): boolean {
    for (let x = n as FakeElement | null; x; x = x.parent) if (x === this) return true;
    return false;
  }

  get textContent(): string {
    if (this._html !== null) {
      // Text outside tags; a scan rather than a regex so no "<" ever survives.
      let t = "";
      let depth = 0;
      for (const ch of this._html) {
        if (ch === "<") depth++;
        else if (ch === ">") depth = Math.max(0, depth - 1);
        else if (depth === 0) t += ch;
      }
      return t;
    }
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.replaceChildren(v);
  }
  /** Serialises children; a raw string assigned to innerHTML is returned verbatim. */
  get innerHTML(): string {
    if (this._html !== null) return this._html;
    return this.children.map((c) => (c instanceof FakeText ? esc(c.data) : c.outerHTML)).join("");
  }
  set innerHTML(v: string) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this._html = String(v);
  }
  get outerHTML(): string {
    const a = [...this.attrs].map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${v.replace(/"/g, "&quot;")}"`)).join("");
    return `<${this.tag}${a}>${this.innerHTML}</${this.tag}>`;
  }

  private matches(s: Sel) {
    return (!s.tag || s.tag === this.tag) && s.classes.every((c) => this.classList.contains(c)) && (!s.attr || this.attrs.has(s.attr));
  }
  querySelectorAll<T = FakeElement>(sel: string): T[] {
    const parts = sel.split(",").map(parseSel);
    const out: FakeElement[] = [];
    const walk = (e: FakeElement) => {
      for (const c of e.children) {
        if (c instanceof FakeText) continue;
        if (parts.some((p) => c.matches(p))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out as unknown as T[];
  }
  querySelector<T = FakeElement>(sel: string): T | null {
    return this.querySelectorAll<T>(sel)[0] ?? null;
  }
  closest<T = FakeElement>(sel: string): T | null {
    const p = parseSel(sel);
    for (let n: FakeElement | null = this; n; n = n.parent) if (n.matches(p)) return n as unknown as T;
    return null;
  }

  focus(_o?: unknown) {
    const prev = this.doc.activeElement;
    if (prev && prev !== this) prev.focused = false;
    this.focused = true;
    this.doc.activeElement = this;
  }
  getBoundingClientRect() {
    return this.rect;
  }
  scrollIntoView(_o?: unknown) {
    this.scrolled++;
  }
  setPointerCapture(_id: number) {}

  dispatchEvent(e: FakeEvent) {
    if (!e.target) e.target = this;
    for (let n: FakeElement | null = this; n && !e.propagationStopped; n = n.parent) n.fire(e);
    return !e.defaultPrevented;
  }
}

export class FakeDocument extends Target {
  documentElement = new FakeElement("html", this);
  body = new FakeElement("body", this);
  activeElement: FakeElement | null = this.body;
  constructor() {
    super();
    this.documentElement.append(this.body);
  }
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
}

export class FakeStorage {
  private m = new Map<string, string>();
  throws = false;
  getItem(k: string) {
    if (this.throws) throw new Error("denied");
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.throws) throw new Error("denied");
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

export class FakeWindow extends Target {
  innerWidth = 1000;
  innerHeight = 800;
  fetch: unknown = undefined;
  setTimeout = globalThis.setTimeout.bind(globalThis);
  clearTimeout = globalThis.clearTimeout.bind(globalThis);
}

export interface Dom {
  document: FakeDocument;
  window: FakeWindow;
  location: { hash: string; pathname: string; search: string; href: string; protocol: string };
  history: { calls: unknown[][]; replaceState(...a: unknown[]): void };
  localStorage: FakeStorage;
  sessionStorage: FakeStorage;
  navigator: { platform: string };
}

const KEYS = ["document", "window", "location", "history", "localStorage", "sessionStorage", "navigator", "innerWidth", "innerHeight"] as const;
let saved: Map<string, PropertyDescriptor | undefined> | null = null;

/** Installs fresh fake globals. Call uninstallDom() in afterAll to restore the originals. */
export function installDom(opts: { platform?: string; hash?: string; href?: string; protocol?: string } = {}): Dom {
  const g = globalThis as Record<string, unknown>;
  if (!saved) {
    saved = new Map();
    for (const k of KEYS) saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
  }
  const window = new FakeWindow();
  const history = { calls: [] as unknown[][], replaceState(...a: unknown[]) { history.calls.push(a); } };
  const dom: Dom = {
    document: new FakeDocument(),
    window,
    location: {
      hash: opts.hash ?? "",
      pathname: "/",
      search: "",
      href: opts.href ?? "http://127.0.0.1:4000/",
      protocol: opts.protocol ?? "http:",
    },
    history,
    localStorage: new FakeStorage(),
    sessionStorage: new FakeStorage(),
    navigator: { platform: opts.platform ?? "Linux x86_64" },
  };
  for (const k of KEYS) {
    const v = k === "innerWidth" ? window.innerWidth : k === "innerHeight" ? window.innerHeight : dom[k as keyof Dom];
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  void g;
  return dom;
}

export function uninstallDom() {
  if (!saved) return;
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  saved = null;
}

/** Replace globalThis.fetch with a recording mock; returns the calls and a restore function. */
export type Call = { url: string; init?: RequestInit };
const realFetch = globalThis.fetch; // captured once, so nested mocks always restore the true original
export function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const orig = realFetch;
  const calls: Call[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}
