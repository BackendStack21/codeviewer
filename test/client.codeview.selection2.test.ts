import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";
import { copyEvent, el, fireSelectionChange, loadCodeView, mount, rng, rowOf, text, type Env, type Mounted } from "./helpers/selfake.ts";

let env: Env;
beforeAll(async () => {
  env = await loadCodeView();
});
afterAll(() => uninstallDom());

const body = Array.from({ length: 1000 }, (_, i) => `line ${i} text`).join("\n");
const small = ["abcdefgh", "ijklmnop", "qrstuvwx"].join("\n");
const tx = (m: Mounted, n: number) => m.row(n).querySelector("tx")!;
const outside = () => el("sidebar", text("elsewhere"));
const doc = () => env.dom.document;
const input = () => env.dom.document.createElement("input") as FakeElement;
const keyA = (init: Record<string, unknown> = {}) => new FakeEvent("keydown", { key: "a", metaKey: true, ...init });
const pressRow = (m: Mounted, n: number, init: Record<string, unknown> = {}) =>
  m.linesEl.dispatchEvent(new FakeEvent("mousedown", { target: tx(m, n), button: 0, ...init }));

/** Bottom-to-top drag: anchor row 50 col 6, focus row 10 col 1. */
function dragUp(m: Mounted) {
  m.sel.set(tx(m, 50).childNodes[2]!, 1, tx(m, 10).childNodes[0]!, 1);
  fireSelectionChange(env);
}

describe("R-02 the selection keeps its direction across a re-render", () => {
  test("a bottom-to-top selection is restored with the anchor on the lower row", () => {
    const m = mount(env, body);
    dragUp(m);
    expect(m.view.selection).toEqual(rng(10, 1, 50, 6));
    const before = m.calls.length;
    m.view.schedule();
    env.flush();
    expect(m.calls.length).toBeGreaterThan(before);
    const last = m.calls[m.calls.length - 1]!;
    expect([rowOf(last.a), last.ao, rowOf(last.f), last.fo]).toEqual([50, 1, 10, 1]);
  });

  test("a top-to-bottom selection keeps its anchor on the upper row", () => {
    const m = mount(env, body);
    m.sel.set(tx(m, 10).childNodes[0]!, 1, tx(m, 50).childNodes[2]!, 1);
    fireSelectionChange(env);
    m.view.schedule();
    env.flush();
    const last = m.calls[m.calls.length - 1]!;
    expect([rowOf(last.a), rowOf(last.f)]).toEqual([10, 50]);
  });

  test("during a drag (primary held) a re-render that destroys the rows still restores anchor and focus as given", () => {
    const m = mount(env, body);
    pressRow(m, 50);
    env.flush();
    dragUp(m);
    m.view.schedule(); // a full re-render of a stale window
    env.flush();
    const last = m.calls[m.calls.length - 1]!;
    expect([rowOf(last.a), last.ao, rowOf(last.f), last.fo]).toEqual([50, 1, 10, 1]);
  });

  test("while the primary button is held and the anchor row survives, the DOM selection is not touched", () => {
    const m = mount(env, body);
    pressRow(m, 50);
    env.flush();
    dragUp(m);
    // a render that patches in place: the rows (and the anchor) stay attached
    Object.defineProperty(m.linesEl, "innerHTML", { configurable: true, get: () => "", set: () => {} });
    const before = m.calls.length;
    m.view.schedule();
    env.flush();
    expect(m.calls.length).toBe(before);
    expect(m.view.selection).toEqual(rng(10, 1, 50, 6));
  });
});

describe("R-01 copy and select-all work without the scroller holding focus", () => {
  test("the scroller can take focus (tabindex -1)", () => {
    const m = mount(env, small);
    expect(m.scroller.getAttribute("tabindex")).toBe("-1");
  });

  test("a copy event on the document is answered with the model text", () => {
    const m = mount(env, body);
    m.view.setRange(rng(0, 0, 900, 4));
    env.flush();
    const { e, set } = copyEvent();
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(set.length).toBe(1);
    expect(set[0]![0]).toBe("text/plain");
    expect(set[0]![1].split("\n").length).toBe(901);
  });

  test("a copy aimed at an input (find bar, palette) is left alone even with a model range", () => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 0, 2, 3));
    const { e, set } = copyEvent();
    e.target = input();
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(set).toEqual([]);
  });

  test("a copy while the DOM selection is elsewhere (outside the view) is left alone", () => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 0, 2, 3));
    const o = outside();
    m.sel.set(o, 0, o, 1);
    const { e, set } = copyEvent();
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(set).toEqual([]);
  });

  test("a copy without any range or selection is left alone", () => {
    mount(env, small);
    const { e, set } = copyEvent();
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(set).toEqual([]);
  });

  test("Cmd+A on the body after interacting with the view selects the whole file", () => {
    const m = mount(env, "alpha\n\tbeta\ngamma");
    pressRow(m, 1);
    const e = keyA();
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(m.view.selection).toEqual(rng(0, 0, 2, 5));
    expect(m.view.selectedText()).toBe("alpha\n\tbeta\ngamma");
  });

  test("Ctrl+A works the same", () => {
    const m = mount(env, small);
    pressRow(m, 0);
    const e = keyA({ metaKey: false, ctrlKey: true });
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(m.view.selection).toEqual(rng(0, 0, 2, 8));
  });

  test("Cmd+A before any interaction with the view is left alone", () => {
    const m = mount(env, small);
    const e = keyA();
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(m.view.selection).toBeNull();
  });

  test("Cmd+A after the last press landed outside the view is left alone", () => {
    const m = mount(env, small);
    pressRow(m, 1);
    doc().dispatchEvent(new FakeEvent("mousedown", { target: outside(), button: 0 }));
    const e = keyA();
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(m.view.selection).toBeNull();
  });

  test("Cmd+A typed into an input stays native even right after clicking the view", () => {
    const m = mount(env, small);
    pressRow(m, 1);
    const e = keyA();
    e.target = input();
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(m.view.selection).toBeNull();
  });
});

describe("R-03 one endpoint outside the rows follows the same outside-the-view rule", () => {
  test("anchor in the rows and focus outside the whole view drops the range", () => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 0, 2, 3));
    m.sel.set(tx(m, 1).childNodes[0]!, 1, outside(), 0);
    fireSelectionChange(env);
    expect(m.view.selection).toBeNull();
  });

  test("anchor in the rows and focus on the lines container (still inside the view) keeps the range", () => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 0, 2, 3));
    m.sel.set(tx(m, 1).childNodes[0]!, 1, m.chrome.querySelector("code-lines")!, 0);
    fireSelectionChange(env);
    expect(m.view.selection).toEqual(rng(0, 0, 2, 3));
  });
});
