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


const fireSel = () => dom.document.dispatchEvent(new FakeEvent("selectionchange"));
const domSel = (anchor: N, focus: N, collapsed: boolean) =>
  setWinSel({ setBaseAndExtent() {}, rangeCount: 1, isCollapsed: collapsed, anchorNode: anchor, anchorOffset: 0, focusNode: focus, focusOffset: 1 });
const down = (target: unknown, init: Record<string, unknown> = {}) =>
  dom.document.dispatchEvent(new FakeEvent("mousedown", { target, button: 0, ...init }));

// "Inside" = anywhere in the code view element (find bar, scroller/scrollbar, gutter, lines container), not only the rows.
function mountWithChrome() {
  setWinSel({ setBaseAndExtent() {} });
  const m = mount(src);
  const chrome = el("code-chrome", el("find-input"), el("code-scroller"), el("code-lines"));
  const inner = m.view.el as FakeElement & Record<string, any>;
  const rowsContains = inner.contains?.bind(inner);
  inner.contains = (n: N) => chrome.contains(n) || m.linesEl.contains(n) || !!rowsContains?.(n);
  m.view.setRange(rng(0, 0, 2, 3));
  return { ...m, chrome };
}

describe("R-01 a non-collapsed selection inside the code view element keeps the range", () => {
  test("both endpoints on the lines container (rows removed by a re-render) keep the range", () => {
    const { view, chrome } = mountWithChrome();
    const container = chrome.querySelector("code-lines")!;
    domSel(container, container, false);
    fireSel();
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("endpoints in the find bar / scroller (inside the element, outside the rows) keep the range", () => {
    const { view, chrome } = mountWithChrome();
    domSel(chrome.querySelector("find-input")!, chrome.querySelector("code-scroller")!, false);
    fireSel();
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("endpoints outside the whole element still clear the range", () => {
    const { view } = mountWithChrome();
    const o = el("sidebar", text("elsewhere"));
    domSel(o, o, false);
    fireSel();
    expect(view.selection).toBeNull();
  });
});

describe("R-02 a primary press inside the code view element keeps the range", () => {
  test("press on the find bar keeps it", () => {
    const { view, chrome } = mountWithChrome();
    down(chrome.querySelector("find-input")!);
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("press on the scroller / scrollbar keeps it", () => {
    const { view, chrome } = mountWithChrome();
    down(chrome.querySelector("code-scroller")!);
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("press outside the element clears it", () => {
    const { view } = mountWithChrome();
    down(el("sidebar", text("elsewhere")));
    expect(view.selection).toBeNull();
  });
});
