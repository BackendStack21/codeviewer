import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";
import { copyEvent, el, fireSelectionChange, loadCodeView, mount, pressDoc, rng, rowOf, scrollTo, text, type Env, type Mounted } from "./helpers/selfake.ts";

let env: Env;
beforeAll(async () => {
  env = await loadCodeView();
});
afterAll(() => uninstallDom());

const body = Array.from({ length: 1000 }, (_, i) => `line ${i} text`).join("\n");
const doc = () => env.dom.document;
const tx = (m: Mounted, n: number) => m.row(n).querySelector("tx")!;
const keyA = (init: Record<string, unknown> = {}) => new FakeEvent("keydown", { key: "a", metaKey: true, ...init });

/** Primary press in a row, like the browser: the mousedown also focuses the scroller. */
function pressIn(m: Mounted, n: number) {
  m.linesEl.dispatchEvent(new FakeEvent("mousedown", { target: tx(m, n).parent, button: 0 }));
  pressDoc(env, tx(m, n).parent, { button: 0 });
  m.scroller.focus();
}
/** Moves keyboard focus to an element outside the view (explorer tree, palette, terminal) without a press. */
function focusElsewhere(tag = "div") {
  const e = doc().createElement(tag) as FakeElement;
  doc().body.append(e);
  e.focus();
  return e;
}
/** DOM Node.contains is inclusive: contains(self) is true. */
function inclusive(m: Mounted) {
  const inner = m.linesEl.contains;
  m.linesEl.contains = (n: unknown) => n === m.linesEl || inner(n);
}

describe("R-04 a held drag whose anchor row is destroyed is restored", () => {
  test("selection collapsed onto the lines container mid-drag is restored with anchor and focus", () => {
    const m = mount(env, body);
    inclusive(m);
    scrollTo(env, m, 2000);
    pressIn(m, 150);
    m.sel.set(tx(m, 150).childNodes[0]!, 2, tx(m, 100).childNodes[0]!, 3);
    fireSelectionChange(env);
    const before = m.calls.length;
    m.sel.setBaseAndExtent(m.linesEl as never, 0, m.linesEl as never, 0);
    m.view.schedule(); // a full re-render of a stale window
    env.flush();
    expect(m.calls.length).toBeGreaterThan(before);
    const last = m.calls[m.calls.length - 1]!;
    expect(rowOf(last.a)).toBe(150);
    expect(rowOf(last.f)).toBeLessThan(150);
  });

  test("anchor still inside a rendered row keeps the browser in charge (no restore)", () => {
    const m = mount(env, body);
    inclusive(m);
    pressIn(m, 50);
    m.sel.set(tx(m, 50).childNodes[2]!, 1, tx(m, 10).childNodes[0]!, 1);
    fireSelectionChange(env);
    Object.defineProperty(m.linesEl, "innerHTML", { configurable: true, get: () => "", set: () => {} });
    const before = m.calls.length;
    m.view.schedule();
    env.flush();
    expect(m.calls.length).toBe(before);
  });

  test("anchor on the lines container with the primary button held is restored even when the window did not move", () => {
    const m = mount(env, body);
    inclusive(m);
    pressIn(m, 20);
    m.sel.set(tx(m, 20).childNodes[0]!, 2, tx(m, 5).childNodes[0]!, 1);
    fireSelectionChange(env);
    m.sel.setBaseAndExtent(m.linesEl as never, 0, m.linesEl as never, 0);
    const before = m.calls.length;
    m.view.schedule();
    env.flush();
    expect(m.calls.length).toBeGreaterThan(before);
    const last = m.calls[m.calls.length - 1]!;
    expect([rowOf(last.a), rowOf(last.f)]).toEqual([20, 5]);
  });
});

describe("R-05 the view only owns the keyboard while focus is inside it", () => {
  test("Cmd+A with focus moved to the explorer is left native", () => {
    const m = mount(env, body);
    pressIn(m, 3);
    m.view.setRange(rng(0, 0, 2, 3));
    const tree = focusElsewhere();
    const e = keyA({ target: tree });
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(m.view.selection).toEqual(rng(0, 0, 2, 3));
  });

  test("copy with focus moved to the explorer is left native", () => {
    const m = mount(env, body);
    pressIn(m, 3);
    m.view.setRange(rng(0, 0, 2, 3));
    const tree = focusElsewhere();
    const c = copyEvent();
    c.e.target = tree;
    doc().dispatchEvent(c.e);
    expect(c.e.defaultPrevented).toBe(false);
    expect(c.set).toEqual([]);
  });

  test("Cmd+A and copy with focus in a terminal textarea or palette input stay native", () => {
    const m = mount(env, body);
    pressIn(m, 3);
    m.view.setRange(rng(0, 0, 2, 3));
    for (const tag of ["textarea", "input"]) {
      const t = focusElsewhere(tag);
      const e = keyA({ target: t });
      doc().dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      const c = copyEvent();
      c.e.target = t;
      doc().dispatchEvent(c.e);
      expect(c.e.defaultPrevented).toBe(false);
    }
  });

  test("Cmd+A with focus inside the view (scroller) selects the whole file", () => {
    const m = mount(env, "alpha\nbeta\ngamma");
    pressIn(m, 1);
    const e = keyA({ target: m.scroller });
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(m.view.selection).toEqual(rng(0, 0, 2, 5));
  });

  test("focus returning to the view after a detour makes it own the keyboard again", () => {
    const m = mount(env, "alpha\nbeta\ngamma");
    pressIn(m, 1);
    focusElsewhere();
    m.scroller.focus();
    const e = keyA({ target: m.scroller });
    doc().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  test("copy with focus inside the view and a model range is answered with the model text", () => {
    const m = mount(env, body);
    pressIn(m, 3);
    m.view.setRange(rng(0, 0, 2, 3));
    const c = copyEvent();
    c.e.target = m.scroller;
    doc().dispatchEvent(c.e);
    expect(c.e.defaultPrevented).toBe(true);
    expect(c.set[0]![1].split("\n").length).toBe(3);
  });

  test("copy with the DOM selection inside the view is answered even when focus is elsewhere", () => {
    const m = mount(env, body);
    m.view.setRange(rng(0, 0, 2, 3));
    m.sel.set(tx(m, 0).childNodes[0]!, 0, tx(m, 2).childNodes[0]!, 1);
    focusElsewhere();
    const c = copyEvent();
    doc().dispatchEvent(c.e);
    expect(c.e.defaultPrevented).toBe(true);
    expect(c.set[0]![0]).toBe("text/plain");
  });

  test("copy with a DOM selection elsewhere and focus outside the view is left native", () => {
    const m = mount(env, body);
    m.view.setRange(rng(0, 0, 2, 3));
    const o = el("sidebar", text("elsewhere"));
    m.sel.set(o, 0, o, 1);
    focusElsewhere();
    const c = copyEvent();
    doc().dispatchEvent(c.e);
    expect(c.e.defaultPrevented).toBe(false);
  });
});
