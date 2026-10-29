import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, uninstallDom } from "./helpers/fakedom.ts";
import { loadCodeView, mount, rng, type Env, type Mounted, type N } from "./helpers/selfake.ts";

let env: Env;
beforeAll(async () => {
  env = await loadCodeView();
});
afterAll(() => uninstallDom());

const body = Array.from({ length: 300 }, (_, i) => `line ${i} text`).join("\n");
const blameOf = (r: N) => r.querySelector("blame");
const shown = (m: Mounted) => m.rows().filter((r) => blameOf(r)).length;
const release = () => {
  env.dom.document.dispatchEvent(new FakeEvent("mouseup", { button: 0 }));
  env.dom.window.dispatchEvent(new FakeEvent("mouseup", { button: 0 }));
};

describe("R-01 a primary press anywhere in the text area holds the label", () => {
  test("press on the lines container (blank space beside or below rows)", () => {
    const m = mount(env, body);
    m.linesEl.dispatchEvent(new FakeEvent("mousedown", { target: m.linesEl, button: 0 }));
    m.view.setBlame(6, "Bob");
    env.flush();
    expect(shown(m)).toBe(0);
    release();
    env.flush();
    expect(blameOf(m.row(6))!.textContent).toBe("Bob");
  });

  test("press on the scroller's blank area", () => {
    const m = mount(env, body);
    m.scroller.dispatchEvent(new FakeEvent("mousedown", { target: m.scroller, button: 0 }));
    m.view.setBlame(6, "Bob");
    env.flush();
    expect(shown(m)).toBe(0);
    release();
    env.flush();
    expect(blameOf(m.row(6))!.textContent).toBe("Bob");
  });

  test("a hold started in blank space does not stick (blur clears it)", () => {
    const m = mount(env, body);
    m.linesEl.dispatchEvent(new FakeEvent("mousedown", { target: m.linesEl, button: 0 }));
    env.dom.window.dispatchEvent(new FakeEvent("blur"));
    m.view.setBlame(6, "Bob");
    env.flush();
    expect(shown(m)).toBe(1);
  });

  test("a right press on blank space does not hold", () => {
    const m = mount(env, body);
    m.linesEl.dispatchEvent(new FakeEvent("mousedown", { target: m.linesEl, button: 2 }));
    m.view.setBlame(6, "Bob");
    env.flush();
    expect(shown(m)).toBe(1);
  });
});

describe("R-02 a non-collapsed model range hides the label", () => {
  test("model range present while the DOM selection reads collapsed", () => {
    const m = mount(env, body);
    m.view.setRange(rng(0, 1, 2, 2));
    env.flush();
    m.sel.isCollapsed = true;
    m.view.setBlame(1, "Ann");
    env.flush();
    expect(shown(m)).toBe(0);
  });

  test("the label returns once the model range is dropped", () => {
    const m = mount(env, body);
    m.view.setRange(rng(0, 1, 2, 2));
    env.flush();
    m.sel.isCollapsed = true;
    m.view.setBlame(1, "Ann");
    m.view.setRange(null);
    env.flush();
    expect(blameOf(m.row(1))!.textContent).toBe("Ann");
  });
});
