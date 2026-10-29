import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FakeElement, FakeEvent, installDom, uninstallDom, type Dom } from "./helpers/fakedom.ts";

let C: typeof import("../src/client/codeview.ts");
let dom: Dom;
let rafQueue: (() => void)[] = [];

beforeAll(async () => {
  dom = installDom();
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  g.requestAnimationFrame = (cb: () => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  g.getComputedStyle = () => ({ getPropertyValue: () => "monospace" });
  const make = dom.document.createElement.bind(dom.document);
  dom.document.createElement = (tag: string) => {
    const el = make(tag);
    (el.style as Record<string, unknown>).setProperty = (k: string, v: string) => (el.style[k] = v);
    if (tag === "canvas") (el as unknown as Record<string, unknown>).getContext = () => ({ font: "", measureText: () => ({ width: 80 }) });
    return el;
  };
  try {
    C = await import("../src/client/codeview.ts");
  } catch {}
});
afterAll(() => uninstallDom());

beforeEach(() => {
  expect(typeof C?.CodeView).toBe("function");
});

const flush = () => {
  const q = rafQueue;
  rafQueue = [];
  for (const f of q) f();
};

/** The fake DOM keeps innerHTML as a string; turn the rendered rows into real fake elements. */
function parseRows(linesEl: FakeElement, html: string) {
  linesEl.children = [];
  const re = /<div class="([^"]*)" data-n="(\d+)"[^>]*>.*?<span class="tx">(.*?)<\/span>(?:<span class="blame">.*?<\/span>)?<\/div>/g;
  for (let m; (m = re.exec(html)); ) {
    const row = dom.document.createElement("div");
    row.setAttribute("class", m[1]!);
    row.setAttribute("data-n", m[2]!);
    const tx = dom.document.createElement("span");
    tx.setAttribute("class", "tx");
    // Strip tags until none remain, so a split tag like "<scr<x>ipt>" cannot survive one pass.
    let text = m[3]!;
    for (let prev = ""; prev !== text; ) [prev, text] = [text, text.replace(/<[^>]*>/g, "")];
    tx.append(text);
    row.append(tx);
    linesEl.append(row);
  }
}

type Rec = { a: Node; ao: number; f: Node; fo: number };
function mount(text: string) {
  const view = new C.CodeView(text, "text", 10) as unknown as Record<string, any>;
  const linesEl = view.linesEl as FakeElement;
  Object.defineProperty(linesEl, "innerHTML", { configurable: true, get: () => "", set: (v: string) => parseRows(linesEl, v) });
  const calls: Rec[] = [];
  view.setSelection = (a: Node, ao: number, f: Node, fo: number) => calls.push({ a, ao, f, fo });
  dom.document.body.append(view.el as FakeElement);
  flush();
  return { view, calls, scroller: view.scroller as FakeElement };
}
const rowN = (n: Node) => Number((n as unknown as FakeElement).closest(".ln")!.dataset.n);
const scrollTo = (v: Record<string, any>, scroller: FakeElement, top: number) => {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new FakeEvent("scroll"));
  flush();
};
const body = Array.from({ length: 1000 }, (_, i) => `line ${i} text`).join("\n");
const rng = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, col: sc }, end: { line: el, col: ec } });
const keyA = (init: Record<string, unknown>) => new FakeEvent("keydown", { key: "a", ...init });

describe("CodeView model range survives re-render (AC-1)", () => {
  test("setRange stores a normalised range", () => {
    const { view } = mount("alpha\nbeta\ngamma");
    view.setRange(rng(2, 3, 0, 1));
    expect(view.selection).toEqual(rng(0, 1, 2, 3));
  });

  test("scrolling the range out of and back into the window keeps it and restores the DOM selection", () => {
    const { view, calls, scroller } = mount(body);
    view.setRange(rng(10, 2, 300, 4));
    flush();
    expect(calls.length).toBeGreaterThan(0);
    scrollTo(view, scroller, 4800); // window ~260..390: line 10 is out, 300 is in
    expect(view.selection).toEqual(rng(10, 2, 300, 4));
    let last = calls[calls.length - 1]!;
    expect(rowN(last.a)).toBeGreaterThanOrEqual(260);
    expect(last.ao).toBe(0);
    expect(rowN(last.f)).toBe(300);
    expect(last.fo).toBe(4);
    scrollTo(view, scroller, 0);
    expect(view.selection).toEqual(rng(10, 2, 300, 4));
    last = calls[calls.length - 1]!;
    expect(rowN(last.a)).toBe(10);
    expect(last.ao).toBe(2);
    expect(rowN(last.f)).toBeLessThan(300); // 300 is now past the window
  });

  test("a range wholly outside the window triggers no DOM restore but is kept", () => {
    const { view, calls, scroller } = mount(body);
    view.setRange(rng(500, 0, 510, 3));
    flush();
    const n = calls.length;
    scrollTo(view, scroller, 0);
    expect(calls.length).toBe(n);
    expect(view.selection).toEqual(rng(500, 0, 510, 3));
  });
});

describe("Cmd/Ctrl+A selects the whole file (AC-2)", () => {
  for (const mod of ["metaKey", "ctrlKey"]) {
    test(`${mod}+A selects everything and is prevented`, () => {
      const { view, scroller } = mount("alpha\n\tbeta\ngamma");
      const e = keyA({ [mod]: true });
      scroller.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      expect(view.selection).toEqual(rng(0, 0, 2, 5));
      expect(view.selectedText()).toBe("alpha\n\tbeta\ngamma");
    });
  }
  test("plain A is left alone", () => {
    const { view, scroller } = mount("alpha\nbeta");
    const e = keyA({});
    scroller.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(view.selection).toBeNull();
  });
  test("selectAll() API matches", () => {
    const { view } = mount("a\nbb\nccc");
    view.selectAll();
    expect(view.selection).toEqual(rng(0, 0, 2, 3));
    expect(view.selectedText()).toBe("a\nbb\nccc");
  });
  test("no selection gives empty selectedText", () => {
    const { view } = mount("a\nbb");
    expect(view.selectedText()).toBe("");
  });
});

describe("copy uses the model, not decorations (AC-3)", () => {
  const long = "x".repeat(5000);
  const text = `short\n${long}\nend`;

  test("selectedText holds the full long line and no label", () => {
    const { view } = mount(text);
    view.setRange(rng(0, 2, 2, 2));
    const t = view.selectedText();
    expect(t).toBe(`ort\n${long}\nen`);
    expect(t).not.toContain("more characters");
  });

  test("the copy event writes model text and is prevented", () => {
    const { view, scroller } = mount(text);
    view.selectAll();
    const set: [string, string][] = [];
    const e = new FakeEvent("copy", { clipboardData: { setData: (t: string, d: string) => set.push([t, d]) } });
    scroller.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(set).toEqual([["text/plain", text]]);
  });

  test("copy with no selection is left to the browser", () => {
    const { scroller } = mount(text);
    const set: unknown[] = [];
    const e = new FakeEvent("copy", { clipboardData: { setData: (...a: unknown[]) => set.push(a) } });
    scroller.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(set).toEqual([]);
  });

  test(".trunc is user-select:none in styles.css", () => {
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
    const m = /\.trunc\s*\{([^}]*)\}/.exec(css);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/user-select:\s*none/);
  });
});
