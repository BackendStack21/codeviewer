import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, uninstallDom, type Dom, type FakeElement } from "./helpers/fakedom.ts";

// Row nodes with just enough DOM (classList, querySelector, append, remove, insertAdjacentHTML) for in-place patching.
class R {
  parent: R | null = null;
  childNodes: any[] = [];
  data = "";
  dataset: Record<string, string> = {};
  html = "";
  constructor(public nodeType: 1 | 3, public cls = "") {}
  get className() {
    return this.cls;
  }
  set className(v: string) {
    this.cls = v;
  }
  get parentElement() {
    return this.parent;
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join("") + (this.html ? this.html.replace(/<[^>]*>/g, "") : "");
  }
  set textContent(v: string) {
    this.html = v;
  }
  get innerHTML() {
    return this.html;
  }
  set innerHTML(v: string) {
    this.html = v;
  }
  get classList() {
    const get = () => this.cls.split(" ").filter(Boolean);
    return {
      contains: (c: string) => get().includes(c),
      add: (...cs: string[]) => void (this.cls = [...new Set([...get(), ...cs])].join(" ")),
      remove: (...cs: string[]) => void (this.cls = get().filter((c) => !cs.includes(c)).join(" ")),
      toggle: (c: string, force?: boolean) => {
        const on = force ?? !get().includes(c);
        if (on) this.cls = [...new Set([...get(), c])].join(" ");
        else this.cls = get().filter((x) => x !== c).join(" ");
        return on;
      },
    };
  }
  add(...cs: R[]) {
    for (const c of cs) {
      c.parent = this;
      this.childNodes.push(c);
    }
    return this;
  }
  append(...cs: any[]) {
    for (const c of cs) if (c && typeof c === "object") this.add(c);
  }
  appendChild(c: any) {
    this.append(c);
    return c;
  }
  insertAdjacentHTML(_pos: string, html: string) {
    const m = /<span class="([^"]*)">([\s\S]*)<\/span>/.exec(html);
    if (!m) return;
    const s = new R(1, m[1]);
    s.html = m[2]!;
    this.add(s);
  }
  remove() {
    if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this);
    this.parent = null;
  }
  contains(n: any): boolean {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  closest(c: string): R | null {
    c = c.replace(/^\./, "");
    for (let x: R | null = this; x; x = x.parent) if (x.nodeType === 1 && x.classList.contains(c)) return x;
    return null;
  }
  querySelector(sel: string): any {
    const cls = /^\.([\w-]+)/.exec(sel)?.[1];
    const n = /data-n="?(\d+)"?/.exec(sel)?.[1];
    for (const k of this.childNodes) {
      if (k.nodeType !== 1) continue;
      const kc = (k.className ?? "") as string;
      if ((!cls || kc.split(" ").includes(cls)) && (n === undefined || k.dataset?.n === n)) return k;
      const r = k.querySelector?.(sel);
      if (r) return r;
    }
    return null;
  }
}
const text = (s: string) => Object.assign(new R(3), { data: s });
const el = (cls: string, ...cs: R[]) => new R(1, cls).add(...cs);

let C: typeof import("../src/client/codeview.ts");
let dom: Dom;
let raf: (() => void)[] = [];
beforeAll(async () => {
  dom = installDom();
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver = class {
    observe() {}
  };
  g.requestAnimationFrame = (cb: () => void) => (raf.push(cb), raf.length);
  g.getComputedStyle = () => ({ getPropertyValue: () => "monospace" });
  const make = dom.document.createElement.bind(dom.document);
  dom.document.createElement = (tag: string) => {
    const e = make(tag);
    (e.style as Record<string, unknown>).setProperty = (k: string, v: string) => (e.style[k] = v);
    if (tag === "canvas") (e as unknown as Record<string, unknown>).getContext = () => ({ measureText: () => ({ width: 80 }) });
    return e;
  };
  C = await import("../src/client/codeview.ts");
});
afterAll(() => uninstallDom());
const flush = () => {
  const q = raf;
  raf = [];
  for (const f of q) f();
};
const setWinSel = (s: unknown) => ((dom.window as unknown as Record<string, unknown>).getSelection = () => s);
const collapsed = { isCollapsed: true, rangeCount: 0, toString: () => "" };
const ranged = { isCollapsed: false, rangeCount: 1, toString: () => "abc", anchorNode: null, focusNode: null };

function mount(src: string) {
  const view = new C.CodeView(src, "text", 10) as unknown as Record<string, any>;
  const linesEl = view.linesEl as FakeElement & Record<string, any>;
  let rows: R[] = [];
  let renders = 0;
  Object.defineProperty(linesEl, "innerHTML", {
    configurable: true,
    get: () => "",
    set: () => {
      renders++;
      rows = [];
      const lines = view.lines as string[];
      for (let i = view.window.first; i < lines.length; i++) {
        const row = el(`ln${i === view.activeLine ? " active" : ""}`, el("g", text(String(i + 1))), el("tx", text(lines[i]!)));
        row.dataset.n = String(i);
        if (view.blame && view.blame.line === i) row.add(Object.assign(el("blame"), { html: view.blame.html }));
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
  Object.defineProperty(linesEl, "firstElementChild", { configurable: true, get: () => rows[0] ?? null });
  linesEl.contains = (n: R) => rows.some((r) => r.contains(n));
  dom.document.body.append(view.el as FakeElement);
  flush();
  return { view, linesEl, rows: () => rows, renders: () => renders };
}
const src = ["abcdefgh", "ijklmnop", "qrstuvwx"].join("\n");
const blameOf = (r: R) => r.querySelector(".blame") as R | null;
const press = (linesEl: FakeElement, row: R, init: Record<string, unknown> = {}) =>
  linesEl.dispatchEvent(new FakeEvent("mousedown", { button: 0, target: row.childNodes[0], ...init }));
const release = () => {
  for (const t of [dom.document, dom.window] as { dispatchEvent: (e: FakeEvent) => unknown }[]) t.dispatchEvent(new FakeEvent("mouseup", { button: 0 }));
};

describe("AC-18: active line and blame patch rows in place", () => {
  test("setActiveLine keeps every row element and its .tx text node; only the active class moves", () => {
    setWinSel(collapsed);
    const { view, rows, renders } = mount(src);
    const before = [...rows()];
    const txs = before.map((r) => r.querySelector(".tx"));
    const texts = txs.map((t) => t.childNodes[0]);
    const n = renders();
    view.setActiveLine(0);
    flush();
    expect(before[0]!.classList.contains("active")).toBe(true);
    view.setActiveLine(2);
    flush();
    expect(renders()).toBe(n);
    expect(rows().length).toBe(before.length);
    rows().forEach((r, i) => {
      expect(r).toBe(before[i]!);
      expect(r.querySelector(".tx")).toBe(txs[i]);
      expect(r.querySelector(".tx").childNodes[0]).toBe(texts[i]);
    });
    expect(before[0]!.classList.contains("active")).toBe(false);
    expect(before[1]!.classList.contains("active")).toBe(false);
    expect(before[2]!.classList.contains("active")).toBe(true);
  });

  test("setBlame adds one .blame span to the active row and removes the old one, keeping row elements", () => {
    setWinSel(collapsed);
    const { view, rows, renders } = mount(src);
    view.setActiveLine(1);
    flush();
    const before = [...rows()];
    const txs = before.map((r) => r.querySelector(".tx"));
    const n = renders();
    view.setBlame(1, "<b>Ann</b> fix");
    flush();
    expect(blameOf(before[1]!)?.innerHTML).toBe("<b>Ann</b> fix");
    view.setBlame(2, "Bob");
    flush();
    expect(blameOf(before[1]!)).toBeNull();
    expect(blameOf(before[2]!)?.innerHTML).toBe("Bob");
    expect(before.filter((r) => blameOf(r)).length).toBe(1);
    view.setBlame(2, null);
    flush();
    expect(before.filter((r) => blameOf(r)).length).toBe(0);
    expect(renders()).toBe(n);
    rows().forEach((r, i) => {
      expect(r).toBe(before[i]!);
      expect(r.querySelector(".tx")).toBe(txs[i]);
    });
  });
});

describe("AC-19: no blame label while the primary button is held", () => {
  test("blame stays hidden during a press and appears for the active line after mouseup", () => {
    setWinSel(collapsed);
    const { view, linesEl, rows } = mount(src);
    press(linesEl, rows()[1]!);
    flush();
    view.setBlame(1, "Ann");
    flush();
    expect(rows().filter((r) => blameOf(r)).length).toBe(0);
    release();
    flush();
    expect(blameOf(rows()[1]!)?.innerHTML).toBe("Ann");
  });

  test("a non-collapsed selection after mouseup suppresses the label", () => {
    setWinSel(collapsed);
    const { view, linesEl, rows } = mount(src);
    press(linesEl, rows()[1]!);
    flush();
    view.setBlame(1, "Ann");
    setWinSel(ranged);
    release();
    flush();
    expect(rows().filter((r) => blameOf(r)).length).toBe(0);
  });

  test("a non-primary press does not hold the label back", () => {
    setWinSel(collapsed);
    const { view, linesEl, rows } = mount(src);
    press(linesEl, rows()[1]!, { button: 2 });
    flush();
    view.setBlame(1, "Ann");
    flush();
    expect(blameOf(rows()[1]!)?.innerHTML).toBe("Ann");
  });
});
