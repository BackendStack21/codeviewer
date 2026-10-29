import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, uninstallDom } from "./helpers/fakedom.ts";
import { fireSelectionChange, loadCodeView, mount, rng, scrollTo, type Env, type Mounted, type N } from "./helpers/selfake.ts";

let env: Env;
beforeAll(async () => {
  env = await loadCodeView();
});
afterAll(() => uninstallDom());

const body = Array.from({ length: 1000 }, (_, i) => `line ${i} text`).join("\n");
const tx = (m: Mounted, n: number) => m.row(n).querySelector("tx")!;
const blameOf = (r: N) => r.querySelector("blame");
const release = () => {
  env.dom.document.dispatchEvent(new FakeEvent("mouseup", { button: 0 }));
  env.dom.window.dispatchEvent(new FakeEvent("mouseup", { button: 0 }));
};
function ranged() {
  const m = mount(env, body);
  m.view.setRange(rng(10, 0, 12, 3));
  m.sel.set(tx(m, 10).childNodes[0]!, 0, tx(m, 12).childNodes[0]!, 3);
  fireSelectionChange(env);
  env.flush();
  return m;
}
const collapseOntoLines = (m: Mounted) => {
  m.sel.setBaseAndExtent(m.linesEl as never, 0, m.linesEl as never, 0);
  fireSelectionChange(env);
  env.flush();
};

describe("R-05 a collapsed DOM selection is not an intent to clear the range", () => {
  for (const incl of [false, true]) {
    const prep = (m: Mounted) => {
      if (!incl) return;
      const inner = m.linesEl.contains;
      m.linesEl.contains = (n: unknown) => n === m.linesEl || inner(n);
    };
    test(`scrolling out of the window (browser collapses onto the lines container) keeps the range (inclusive=${incl})`, () => {
      const m = ranged();
      prep(m);
      scrollTo(env, m, 2400);
      collapseOntoLines(m);
      expect(m.view.selection).toEqual(rng(10, 0, 12, 3));
    });

    test(`scrolling back restores the DOM selection from the kept range (inclusive=${incl})`, () => {
      const m = ranged();
      prep(m);
      scrollTo(env, m, 2400);
      collapseOntoLines(m);
      m.calls.length = 0;
      scrollTo(env, m, 0);
      expect(m.view.selection).toEqual(rng(10, 0, 12, 3));
      const last = m.calls[m.calls.length - 1]!;
      expect([last.a, last.f].map((n) => Number(n.closest("ln")!.dataset.n))).toEqual([10, 12]);
      expect(last.ao).toBe(0);
      expect(last.f).toBe(tx(m, 12).childNodes[1]!.childNodes[0]!); // col 3 sits in the t-k text node
      expect(last.fo).toBe(1);
    });
  }

  test("a collapsed selection inside a row with no render pending keeps the range", () => {
    const m = ranged();
    m.sel.setBaseAndExtent(tx(m, 11).childNodes[0]!, 2, tx(m, 11).childNodes[0]!, 2);
    fireSelectionChange(env);
    expect(m.view.selection).toEqual(rng(10, 0, 12, 3));
  });

  test("a plain click on a row clears the range and the blame label returns after mouseup", () => {
    const m = ranged();
    m.view.setBlame(30, "Ann");
    env.flush();
    expect(blameOf(m.row(30))).toBeNull(); // hidden while the range exists
    m.linesEl.dispatchEvent(new FakeEvent("mousedown", { target: tx(m, 30).parent, button: 0 }));
    expect(m.view.selection).toBeNull();
    m.sel.setBaseAndExtent(tx(m, 30).childNodes[0]!, 1, tx(m, 30).childNodes[0]!, 1);
    fireSelectionChange(env);
    env.flush();
    expect(m.view.selection).toBeNull();
    expect(blameOf(m.row(30))).toBeNull(); // still held
    release();
    env.flush();
    expect(blameOf(m.row(30))!.textContent).toBe("Ann");
  });
});
