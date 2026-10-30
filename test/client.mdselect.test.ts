import { afterAll, beforeAll, expect, test } from "bun:test";
import { FakeEvent, installDom, uninstallDom, type Dom } from "./helpers/fakedom.ts";

let V: typeof import("../src/client/mdview.ts");
let dom: Dom;
beforeAll(async () => {
  dom = installDom();
  V = await import("../src/client/mdview.ts");
});
afterAll(() => uninstallDom());

/** Fakes the selection API: records what was selected. */
function fakeSelection() {
  const sel = { ranges: [] as unknown[], removeAllRanges() { this.ranges = []; }, addRange(r: unknown) { this.ranges.push(r); } };
  const w = dom.window as unknown as Record<string, unknown>;
  const d = dom.document as unknown as Record<string, unknown>;
  w.getSelection = () => sel;
  d.createRange = () => {
    const r = { node: null as unknown, selectNodeContents(n: unknown) { this.node = n; } };
    return r;
  };
  return sel;
}

const key = (init: Record<string, unknown>) => {
  const e = new FakeEvent("keydown", { bubbles: true, cancelable: true }) as unknown as Record<string, unknown>;
  Object.assign(e, { key: "a", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, target: dom.document.body }, init);
  return e as unknown as KeyboardEvent;
};

test("⌘A on the visible preview selects the rendered document only", () => {
  const sel = fakeSelection();
  const v = new V.MarkdownView("# Hi\n\ntext");
  const e = key({});
  dom.document.dispatchEvent(e as unknown as Event);
  expect(sel.ranges.length).toBe(0); // not the active tab yet
  v.setActive(true);
  const e2 = key({});
  dom.document.dispatchEvent(e2 as unknown as Event);
  expect(e2.defaultPrevented).toBe(true);
  expect(sel.ranges.length).toBe(1);
  expect((sel.ranges[0] as { node: unknown }).node).toBe((v as unknown as { root: unknown }).root);
  expect((sel.ranges[0] as { node: unknown }).node).not.toBe(v.el);
  v.dispose();
});

test("⌘A is left alone when already handled, in an input, or with other modifiers", () => {
  const sel = fakeSelection();
  const v = new V.MarkdownView("text");
  v.setActive(true);
  const input = dom.document.createElement("input");
  for (const init of [{ defaultPrevented: true }, { target: input }, { shiftKey: true }, { key: "b" }, { metaKey: false, ctrlKey: false }]) {
    const e = key(init);
    dom.document.dispatchEvent(e as unknown as Event);
    expect(sel.ranges.length).toBe(0);
  }
  v.dispose();
  const e = key({});
  dom.document.dispatchEvent(e as unknown as Event);
  expect(sel.ranges.length).toBe(0); // disposed views unhook
});
