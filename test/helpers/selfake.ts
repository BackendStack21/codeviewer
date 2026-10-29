// Shared fakes for code view selection tests: a node tree with childNodes/nodeType (so text-offset <->
// node mapping runs for real), a recording Selection, and a CodeView mount that renders real-ish rows.
import { FakeEvent, installDom, type Dom, type FakeElement } from "./fakedom.ts";

export class N {
  parent: N | null = null;
  childNodes: N[] = [];
  data = "";
  dataset: Record<string, string> = {};
  constructor(
    public nodeType: 1 | 3,
    public cls = "",
  ) {}
  get parentElement() {
    return this.parent;
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join("");
  }
  get className() {
    return this.cls;
  }
  set className(v: string) {
    this.cls = v;
  }
  get classList() {
    const get = () => this.cls.split(" ").filter(Boolean);
    return {
      contains: (c: string) => get().includes(c),
      add: (...cs: string[]) => void (this.cls = [...new Set([...get(), ...cs])].join(" ")),
      remove: (...cs: string[]) => void (this.cls = get().filter((c) => !cs.includes(c)).join(" ")),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !get().includes(c);
        this.cls = (on ? [...new Set([...get(), c])] : get().filter((x) => x !== c)).join(" ");
        return on;
      },
    };
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  append(...cs: N[]) {
    this.add(...cs);
  }
  appendChild(c: N) {
    this.add(c);
    return c;
  }
  remove() {
    if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this);
    this.parent = null;
  }
  /** Understands one `<span class="x">inner</span>` fragment (all the code view ever inserts). */
  insertAdjacentHTML(_pos: string, html: string) {
    const open = html.indexOf('class="');
    const gt = html.indexOf(">");
    const end = html.lastIndexOf("</span>");
    if (open < 0 || gt < 0 || end < gt) return;
    const cls = html.slice(open + 7, html.indexOf('"', open + 7));
    this.add(new N(1, cls).add(text(html.slice(gt + 1, end))));
  }
  add(...cs: N[]) {
    for (const c of cs) {
      c.parent = this;
      this.childNodes.push(c);
    }
    return this;
  }
  contains(n: N | null): boolean {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  closest(c: string): N | null {
    c = c.replace(/^\./, "");
    for (let x: N | null = this; x; x = x.parent) if (x.nodeType === 1 && x.classList.contains(c)) return x;
    return null;
  }
  querySelector(c: string): N | null {
    c = c.replace(/^\./, "");
    for (const k of this.childNodes) {
      if (k.nodeType !== 1) continue;
      if (k.classList.contains(c)) return k;
      const r = k.querySelector(c);
      if (r) return r;
    }
    return null;
  }
}
export const text = (s: string) => Object.assign(new N(3), { data: s });
export const el = (cls: string, ...cs: N[]) => new N(1, cls).add(...cs);

export class FakeSelection {
  anchorNode: N | null = null;
  anchorOffset = 0;
  focusNode: N | null = null;
  focusOffset = 0;
  rangeCount = 0;
  isCollapsed = true;
  set(a: N, ao: number, f: N, fo: number, collapsed = false) {
    this.anchorNode = a;
    this.anchorOffset = ao;
    this.focusNode = f;
    this.focusOffset = fo;
    this.rangeCount = 1;
    this.isCollapsed = collapsed;
  }
  setBaseAndExtent(a: N, ao: number, f: N, fo: number) {
    this.set(a, ao, f, fo, a === f && ao === fo);
  }
}

export interface Env {
  dom: Dom;
  C: typeof import("../../src/client/codeview.ts");
  flush(): void;
}

/** Installs the fake DOM plus the globals CodeView needs, then imports it. Pair with uninstallDom(). */
export async function loadCodeView(): Promise<Env> {
  const dom = installDom();
  let raf: (() => void)[] = [];
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  g.requestAnimationFrame = (cb: () => void) => (raf.push(cb), raf.length);
  g.getComputedStyle = () => ({ getPropertyValue: () => "monospace" });
  const make = dom.document.createElement.bind(dom.document);
  dom.document.createElement = (tag: string) => {
    const e = make(tag);
    (e.style as Record<string, unknown>).setProperty = (k: string, v: string) => (e.style[k] = v);
    if (tag === "canvas") (e as unknown as Record<string, unknown>).getContext = () => ({ font: "", measureText: () => ({ width: 80 }) });
    return e;
  };
  const C = await import("../../src/client/codeview.ts");
  return {
    dom,
    C,
    flush() {
      const q = raf;
      raf = [];
      for (const f of q) f();
    },
  };
}

const MAX_COLS = 4000;
export type Rec = { a: N; ao: number; f: N; fo: number };

/** Mounts a CodeView whose rows are built as N trees for the current render window. */
export function mount(env: Env, src: string) {
  const view = new env.C.CodeView(src, "text", 10) as unknown as Record<string, any>;
  const linesEl = view.linesEl as FakeElement & Record<string, any>;
  let rows: N[] = [];
  let html = "";
  Object.defineProperty(linesEl, "innerHTML", {
    configurable: true,
    get: () => html,
    set: (v: string) => {
      html = v;
      rows = [];
      const lines = view.lines as string[];
      const last = Math.min(lines.length, view.window.last);
      // per-row class list and blame markup as the code view wrote them
      const segs = new Map<string, string>();
      for (const part of v.split('<div class="').slice(1)) {
        const n = part.slice(part.indexOf('data-n="') + 8, part.indexOf('"', part.indexOf('data-n="') + 8));
        segs.set(n, part);
      }
      for (let i = view.window.first; i < last; i++) {
        const l = lines[i]!;
        const long = l.length > MAX_COLS;
        const s = long ? l.slice(0, MAX_COLS) : l;
        const tx = el("tx", text(s.slice(0, 2)), el("t-k", text(s.slice(2, 5))), text(s.slice(5)), ...(long ? [el("trunc", text(" … more characters"))] : []));
        const seg = segs.get(String(i)) ?? "";
        const row = el(seg.slice(0, seg.indexOf('"')) || "ln", el("g", text(String(i + 1))), tx);
        row.dataset.n = String(i);
        const b = seg.indexOf('<span class="blame">');
        if (b >= 0) row.insertAdjacentHTML("beforeend", seg.slice(b, seg.lastIndexOf("</span>") + 7));
        rows.push(row);
      }
    },
  });
  linesEl.querySelectorAll = () => rows;
  linesEl.querySelector = (sel: string) => {
    const n = /data-n="?(\d+)"?/.exec(sel)?.[1];
    return rows.find((r) => n === undefined || r.dataset.n === n) ?? null;
  };
  Object.defineProperty(linesEl, "children", { configurable: true, get: () => rows });
  linesEl.contains = (n: N) => rows.some((r) => r.contains(n));
  // The code view element also holds the find bar and the scroller (and its scrollbar).
  const chrome = el("code-chrome", el("find-input"), el("code-scroller"), el("code-lines"));
  const root = view.el as FakeElement & Record<string, any>;
  const rootContains = root.contains.bind(root);
  root.contains = (n: N | null) => !!n && (chrome.contains(n) || linesEl.contains(n) || rootContains(n));
  const sel = new FakeSelection();
  (env.dom.window as unknown as Record<string, unknown>).getSelection = () => sel;
  const calls: Rec[] = [];
  view.setSelection = (a: N, ao: number, f: N, fo: number) => {
    calls.push({ a, ao, f, fo });
    sel.setBaseAndExtent(a, ao, f, fo);
  };
  env.dom.document.body.append(root);
  env.flush();
  return {
    view,
    calls,
    sel,
    chrome,
    linesEl,
    scroller: view.scroller as FakeElement,
    rows: () => rows,
    row: (n: number) => rows.find((r) => r.dataset.n === String(n))!,
    html: () => html,
  };
}
export type Mounted = ReturnType<typeof mount>;

export const rng = (sl: number, sc: number, el_: number, ec: number) => ({ start: { line: sl, col: sc }, end: { line: el_, col: ec } });
export const rowOf = (n: N) => Number(n.closest("ln")!.dataset.n);

export function scrollTo(env: Env, m: Mounted, top: number) {
  m.scroller.scrollTop = top;
  m.scroller.dispatchEvent(new FakeEvent("scroll"));
  env.flush();
}
export const fireSelectionChange = (env: Env) => env.dom.document.dispatchEvent(new FakeEvent("selectionchange"));
export const pressDoc = (env: Env, target: unknown, init: Record<string, unknown> = {}) =>
  env.dom.document.dispatchEvent(new FakeEvent("mousedown", { target, button: 0, ...init }));
export function copyEvent() {
  const set: [string, string][] = [];
  const e = new FakeEvent("copy", { clipboardData: { setData: (t: string, d: string) => set.push([t, d]) } });
  return { e, set };
}
