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

function mount(src: string) {
  const view = new C.CodeView(src, "text", 10) as unknown as Record<string, any>;
  const linesEl = view.linesEl as FakeElement & Record<string, any>;
  let rows: N[] = [];
  Object.defineProperty(linesEl, "innerHTML", {
    configurable: true,
    get: () => "",
    set: () => {
      rows = [];
      const lines = view.lines as string[];
      for (let i = view.window.first; i < Math.min(lines.length, view.window.last); i++) {
        const row = el("ln", el("g", text(String(i + 1))), el("tx", text(lines[i]!)));
        row.dataset.n = String(i);
        rows.push(row);
      }
    },
  });
  linesEl.querySelectorAll = () => rows;
  linesEl.contains = (n: N) => rows.some((r) => r.contains(n));
  dom.document.body.append(view.el as FakeElement);
  flush();
  return { view, scroller: view.scroller as FakeElement };
}
const rng = (sl: number, sc: number, el_: number, ec: number) => ({ start: { line: sl, col: sc }, end: { line: el_, col: ec } });
const body = Array.from({ length: 1000 }, (_, i) => `line ${i} text`).join("\n");
const fire = () => dom.document.dispatchEvent(new FakeEvent("selectionchange"));

/** A DOM selection that, like a browser, records what setBaseAndExtent set. */
function liveSelection() {
  const sel: Record<string, any> = {
    rangeCount: 0,
    isCollapsed: true,
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0,
    setBaseAndExtent(a: N, ao: number, f: N, fo: number) {
      Object.assign(sel, { rangeCount: 1, isCollapsed: false, anchorNode: a, anchorOffset: ao, focusNode: f, focusOffset: fo });
    },
  };
  (dom.window as unknown as Record<string, unknown>).getSelection = () => sel;
  return sel;
}
const scrollTo = (scroller: FakeElement, top: number) => {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new FakeEvent("scroll"));
  flush();
};

describe("the DOM selection set by a restore must not overwrite the model (R-01)", () => {
  test("a range partly outside the window survives restore + the browser's selectionchange", () => {
    liveSelection();
    const { view, scroller } = mount(body);
    view.setRange(rng(10, 2, 300, 4));
    flush();
    fire();
    expect(view.selection).toEqual(rng(10, 2, 300, 4)); // end clamped to the window by the restore
    scrollTo(scroller, 4800); // line 10 leaves the window; the restore clamps the anchor to the window start
    fire();
    expect(view.selection).toEqual(rng(10, 2, 300, 4));
    scrollTo(scroller, 0);
    fire();
    expect(view.selection).toEqual(rng(10, 2, 300, 4));
    expect(view.selectedText().startsWith("ne 10 text")).toBe(true);
  });

  test("a genuine user selection made afterwards still replaces the model range", () => {
    const sel = liveSelection();
    const { view, scroller } = mount(body);
    view.setRange(rng(10, 2, 300, 4));
    flush();
    fire();
    const tx = (n: number) => (view.linesEl.querySelectorAll() as N[]).find((r) => r.dataset.n === String(n))!.querySelector("tx")!;
    Object.assign(sel, { rangeCount: 1, isCollapsed: false, anchorNode: tx(5).childNodes[0], anchorOffset: 1, focusNode: tx(7).childNodes[0], focusOffset: 3 });
    fire();
    expect(view.selection).toEqual(rng(5, 1, 7, 3));
    void scroller;
  });
});
