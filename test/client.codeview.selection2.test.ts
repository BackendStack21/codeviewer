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

describe("restoring the DOM selection maps text offsets to text nodes", () => {
  test("default seam calls getSelection().setBaseAndExtent with resolved text nodes", () => {
    const calls: unknown[][] = [];
    setWinSel({ setBaseAndExtent: (...a: unknown[]) => calls.push(a) });
    const { view } = mount(src);
    view.setRange(rng(0, 1, 2, 6)); // line 0 col 1 ("a|b"), line 2 col 6 inside the trailing text node
    flush();
    expect(calls.length).toBe(1);
    const [an, ao, fn, fo] = calls[0] as [N, number, N, number];
    expect(an.data).toBe("ab");
    expect(ao).toBe(1);
    expect(fn.data).toBe("vwx"); // "qr" + "stu" + "vwx": offset 6 is 1 into the last node
    expect(fo).toBe(1);
  });

  test("offset spanning nested spans lands in the right node; past the end lands at the end of the last text", () => {
    const calls: { fn: N; fo: number }[] = [];
    const { view } = mount(src);
    view.setSelection = (_a: unknown, _ao: number, f: N, fo: number) => calls.push({ fn: f, fo });
    view.setRange(rng(0, 0, 0, 3));
    flush();
    expect(calls.at(-1)!.fn.data).toBe("cde");
    expect(calls.at(-1)!.fo).toBe(1);
    view.setRange(rng(0, 0, 1, 99));
    flush();
    expect(calls.at(-1)!.fn.data).toBe("nop"); // the trunc label is skipped; clamps to the end of real text
    expect(calls.at(-1)!.fo).toBe(3);
  });

  test("a row without text nodes anchors on its element", () => {
    const calls: { fn: unknown; fo: number }[] = [];
    const { view } = mount("\nx");
    view.setSelection = (_a: unknown, _ao: number, f: unknown, fo: number) => calls.push({ fn: f, fo });
    view.setRange(rng(0, 0, 0, 0));
    flush();
    expect(calls.at(-1)!.fo).toBe(0);
  });

  test("no rendered row for an endpoint means no DOM selection call", () => {
    const calls: unknown[] = [];
    const { view } = mount(src, () => []);
    view.setSelection = () => calls.push(1);
    view.setRange(rng(0, 0, 1, 2));
    flush();
    expect(calls).toEqual([]);
  });
});

describe("selectionchange mirrors the DOM selection into the model range", () => {
  const fire = () => dom.document.dispatchEvent(new FakeEvent("selectionchange"));
  const sel = (an: N, ao: number, fn: N, fo: number, extra = {}) => ({ rangeCount: 1, isCollapsed: false, anchorNode: an, anchorOffset: ao, focusNode: fn, focusOffset: fo, ...extra });

  test("text and element endpoints, in either direction, become a normalised range", () => {
    const { view, rows } = mount(src);
    const r = rows();
    const tx0 = r[0]!.querySelector("tx")!;
    const tx2 = r[2]!.querySelector("tx")!;
    // anchor: second span of line 2 (after "qr"), offset 2 -> col 4; focus: line 0 tx element, child index 1 -> col 2
    setWinSel(sel(tx2.childNodes[1]!.childNodes[0]!, 2, tx0, 1));
    fire();
    expect(view.selection).toEqual(rng(0, 2, 2, 4));
    // text node in first and trailing text nodes
    setWinSel(sel(tx0.childNodes[0]!, 1, tx0.childNodes[2]!, 2));
    fire();
    expect(view.selection).toEqual(rng(0, 1, 0, 7));
    // an element node that is a span child of the row text, counting preceding children
    setWinSel(sel(tx0.childNodes[1]!, 1, r[1]!.querySelector("tx")!, 3));
    fire();
    expect(view.selection).toEqual(rng(0, 5, 1, 8)); // span element offset 1 = "ab" + "cde"
  });

  test("collapsed, empty or foreign selections leave the model untouched", () => {
    const { view, rows } = mount(src);
    const tx0 = rows()[0]!.querySelector("tx")!;
    view.setRange(rng(1, 0, 1, 2));
    for (const s of [null, sel(tx0, 0, tx0, 0, { isCollapsed: true }), sel(tx0, 0, tx0, 1, { rangeCount: 0 }), sel(tx0, 0, tx0, 1, { anchorNode: null }), sel(text("x"), 0, tx0, 1)]) {
      setWinSel(s);
      fire();
      expect(view.selection).toEqual(rng(1, 0, 1, 2));
    }
  });

  test("a plain mousedown on a row clears the model range", () => {
    setWinSel({ setBaseAndExtent() {} });
    const { view, linesEl, rows } = mount(src);
    view.setRange(rng(0, 0, 2, 3));
    const row = rows()[1]!;
    const g = row.querySelector("g")!;
    linesEl.dispatchEvent(new FakeEvent("mousedown", { target: g }));
    expect(view.selection).toBeNull();
  });
});
