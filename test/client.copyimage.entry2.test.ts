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
import { copyPng, type CopyImageDeps } from "../src/client/copyimage.ts";
import { copyImageKey } from "../src/client/keys.ts";
import { bindSelectionMenu, selectionSnapshot } from "../src/client/copyentry.ts";

describe("R-01 right-click inside a selection keeps the model range", () => {
  const press = (button: number) => {
    setWinSel({ setBaseAndExtent() {} });
    const { view, linesEl, rows } = mount(src);
    view.setRange(rng(0, 0, 2, 3));
    const g = rows()[1]!.querySelector("g")!;
    linesEl.dispatchEvent(new FakeEvent("mousedown", { target: g, button }));
    return view;
  };
  test("secondary button (2) keeps the selection", () => {
    expect(press(2).selection).toEqual(rng(0, 0, 2, 3));
  });
  test("middle button (1) keeps the selection", () => {
    expect(press(1).selection).toEqual(rng(0, 0, 2, 3));
  });
  test("primary button (0) still clears it", () => {
    expect(press(0).selection).toBeNull();
  });
  test("no dead context-menu hook remains on the code view (AC-12)", () => {
    const { view } = mount(src);
    expect("onContextMenu" in view).toBe(false);
    expect((view.scroller as FakeElement).listenerCount("contextmenu")).toBe(0);
  });
  test("the menu is wired through bindSelectionMenu: contextmenu with a selection shows Copy / Copy as Image", () => {
    setWinSel({ setBaseAndExtent() {} });
    const { view } = mount(src);
    view.setRange(rng(0, 0, 2, 3));
    const shown: string[][] = [];
    bindSelectionMenu(view.el as FakeElement as never, { hasSelection: () => view.selection !== null, copy() {}, copyImage() {} }, (_e, items) => shown.push(items.map((i) => i.label)));
    (view.el as FakeElement).dispatchEvent(new FakeEvent("contextmenu"));
    expect(shown).toEqual([["Copy", "Copy as Image"]]);
  });
});

describe("R-02 selection snapshot taken when the palette opens", () => {
  test("value() returns the selection captured by take() even after the live one is gone", () => {
    let live: string | null = "range-A";
    const s = selectionSnapshot(() => live);
    s.take();
    live = null;
    expect(s.value()).toBe("range-A");
  });
  test("take() replaces the snapshot; clear() drops it", () => {
    let live: string | null = "A";
    const s = selectionSnapshot(() => live);
    s.take();
    live = "B";
    s.take();
    expect(s.value()).toBe("B");
    s.clear();
    expect(s.value()).toBeNull();
  });
  test("take() with no live selection leaves value() null", () => {
    const s = selectionSnapshot<string>(() => null);
    s.take();
    expect(s.value()).toBeNull();
  });
});

describe("R-03 copyImageKey ignores text fields", () => {
  const e = (target: unknown) => ({ key: "C", metaKey: true, shiftKey: true, target });
  const o = { isMac: true, inTerm: false };
  test("input, textarea and contenteditable targets are not intercepted", () => {
    expect(copyImageKey(e({ tagName: "INPUT" }), o)).toBe(false);
    expect(copyImageKey(e({ tagName: "TEXTAREA" }), o)).toBe(false);
    expect(copyImageKey(e({ tagName: "DIV", isContentEditable: true }), o)).toBe(false);
  });
  test("a plain element or no target still fires", () => {
    expect(copyImageKey(e({ tagName: "DIV" }), o)).toBe(true);
    expect(copyImageKey(e(undefined), o)).toBe(true);
  });
});

describe("R-06 copyPng does not leave the png promise unhandled", () => {
  test("a png that rejects while write() is still pending raises no unhandledRejection", async () => {
    const seen: unknown[] = [];
    const on = (r: unknown) => void seen.push(r);
    process.on("unhandledRejection", on);
    try {
      class Item {
        constructor(public d: Record<string, Promise<Blob>>) {}
      }
      const deps: CopyImageDeps = {
        renderPng: async () => new Blob(),
        clipboard: { ClipboardItem: Item, write: () => new Promise<void>((_, rej) => setTimeout(() => rej(new Error("w")), 30)) },
        copyText: () => {},
        notify: () => {},
      };
      const res = await copyPng(deps, Promise.reject(new Error("render")));
      await new Promise((r) => setTimeout(r, 20));
      expect(res).toBe("failed");
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });
});
