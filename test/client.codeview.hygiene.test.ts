import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, uninstallDom, type Dom, type FakeElement } from "./helpers/fakedom.ts";

// A small real-DOM-like node tree (childNodes, nodeType) so text-offset <-> node mapping runs for real.
class N {
  parent: N | null = null;
  childNodes: N[] = [];
  data = "";
  dataset: Record<string, string> = {};
  constructor(public nodeType: 1 | 3, public cls = "") {}
  get parentElement() {
    return this.parent;
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join("");
  }
  get classList() {
    return { contains: (c: string) => this.cls.split(" ").includes(c) };
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
const text = (s: string) => Object.assign(new N(3), { data: s });
const el = (cls: string, ...cs: N[]) => new N(1, cls).add(...cs);

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

function mount(src: string, rowsOverride?: () => N[]) {
  const view = new C.CodeView(src, "text", 10) as unknown as Record<string, any>;
  const linesEl = view.linesEl as FakeElement & Record<string, any>;
  let rows: N[] = [];
  Object.defineProperty(linesEl, "innerHTML", {
    configurable: true,
    get: () => "",
    set: () => {
      rows = [];
      const lines = view.lines as string[];
      for (let i = view.window.first; i < Math.min(lines.length, 5); i++) {
        const l = lines[i]!;
        const tx = el("tx", text(l.slice(0, 2)), el("t-k", text(l.slice(2, 5))), text(l.slice(5)), ...(i === 1 ? [el("trunc", text(" … more characters"))] : []));
        const row = el("ln", el("g", text(String(i + 1))), tx);
        row.dataset.n = String(i);
        rows.push(row);
      }
    },
  });
  linesEl.querySelectorAll = () => (rowsOverride ? rowsOverride() : rows);
  linesEl.contains = (n: N) => rows.some((r) => r.contains(n));
  dom.document.body.append(view.el as FakeElement);
  flush();
  return { view, linesEl, rows: () => rows };
}
const rng = (sl: number, sc: number, el_: number, ec: number) => ({ start: { line: sl, col: sc }, end: { line: el_, col: ec } });
const setWinSel = (s: unknown) => ((dom.window as unknown as Record<string, unknown>).getSelection = () => s);
const src = ["abcdefgh", "ijklmnop", "qrstuvwx"].join("\n");

import { bindSelectionMenu } from "../src/client/copyentry.ts";

const outside = () => el("sidebar", text("elsewhere"));
const fireSel = () => dom.document.dispatchEvent(new FakeEvent("selectionchange"));
const domSel = (anchor: N, focus: N, collapsed: boolean) =>
  setWinSel({ setBaseAndExtent() {}, rangeCount: 1, isCollapsed: collapsed, anchorNode: anchor, anchorOffset: 0, focusNode: focus, focusOffset: 1 });
const down = (target: unknown, init: Record<string, unknown> = {}) =>
  dom.document.dispatchEvent(new FakeEvent("mousedown", { target, button: 0, ...init }));

describe("AC-10 a stale model range is dropped when the user acts outside the lines", () => {
  const ranged = () => {
    setWinSel({ setBaseAndExtent() {} });
    const m = mount(src);
    m.view.setRange(rng(0, 0, 2, 3));
    return m;
  };
  test("a non-collapsed selection outside the code view's lines clears the range", () => {
    const { view } = ranged();
    const o = outside();
    domSel(o, o, false);
    fireSel();
    expect(view.selection).toBeNull();
  });
  test("a collapsed selectionchange outside the lines (virtualized re-render) keeps the range", () => {
    const { view } = ranged();
    const o = outside();
    domSel(o, o, true);
    fireSel();
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("a primary press outside the lines clears the range", () => {
    const { view } = ranged();
    down(outside());
    expect(view.selection).toBeNull();
  });
  test("a Ctrl+press or secondary press outside the lines keeps the range", () => {
    const { view } = ranged();
    down(outside(), { ctrlKey: true });
    down(outside(), { button: 2 });
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("a primary press on the context menu (Copy item) keeps the range", () => {
    const { view } = ranged();
    const item = el("ctx-item", text("Copy"));
    el("ctx-menu", item);
    down(item);
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("a press inside the lines is left to the row handler (the document hook does not clear)", () => {
    const { view, rows } = ranged();
    down(rows()[1]!.querySelector("g")!);
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
  });
});

describe("AC-11 right/Ctrl-click on a line moves the active line and keeps the range", () => {
  const press = (init: Record<string, unknown>, marked = false) => {
    setWinSel({ setBaseAndExtent() {} });
    const { view, linesEl, rows } = mount(src);
    view.setRange(rng(0, 0, 2, 3));
    if (marked) view.gitMarks = new Uint8Array([0, 1, 0]);
    let peeks = 0;
    view.togglePeek = () => void peeks++;
    const g = rows()[1]!.querySelector("g")!;
    const ev = new FakeEvent("mousedown", { target: g, button: 0, ...init });
    linesEl.dispatchEvent(ev);
    return { view, peeks, ev };
  };
  test("secondary press moves the active line and keeps the selection", () => {
    const { view } = press({ button: 2 });
    expect(view.activeLine).toBe(1);
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("Ctrl+click moves the active line and keeps the selection", () => {
    const { view } = press({ ctrlKey: true });
    expect(view.activeLine).toBe(1);
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("right-click on a change bar does not open the git peek", () => {
    const { view, peeks } = press({ button: 2 }, true);
    expect(peeks).toBe(0);
    expect(view.activeLine).toBe(1);
  });
  test("Ctrl+click on a change bar does not open the git peek", () => {
    const { peeks } = press({ ctrlKey: true }, true);
    expect(peeks).toBe(0);
  });
  test("primary click on a change bar still opens the peek and clears the selection", () => {
    const { view, peeks, ev } = press({}, true);
    expect(peeks).toBe(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(view.selection).toBeNull();
  });
});
