import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

describe("AC-15 text copy never includes gutter line numbers", () => {
  test("the copy event over multiple plain lines writes exactly the model text", () => {
    expect(typeof C?.CodeView).toBe("function");
    const text = "alpha\nbeta\ngamma\ndelta";
    const view = new C.CodeView(text, "text", 10) as unknown as Record<string, any>;
    dom.document.body.append(view.el as FakeElement);
    const q = rafQueue;
    rafQueue = [];
    for (const f of q) f();
    view.setRange({ start: { line: 0, col: 0 }, end: { line: 2, col: 5 } });
    const set: [string, string][] = [];
    const e = new FakeEvent("copy", { clipboardData: { setData: (t: string, d: string) => set.push([t, d]) } });
    (view.scroller as FakeElement).dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(set).toEqual([["text/plain", "alpha\nbeta\ngamma"]]);
    expect(view.selectedText()).toBe("alpha\nbeta\ngamma");
  });
});
