import { afterAll, expect, test } from "bun:test";
import { uninstallDom } from "./helpers/fakedom.ts";
import { loadCodeView, mount } from "./helpers/selfake.ts";

afterAll(() => uninstallDom());

test("the content width counts tab-indented lines whatever their order", async () => {
  const env = await loadCodeView();
  const w1 = (mount(env, "abcdefghijklm\n\t\t\t\tabcdefgh").view as unknown as { sizer: HTMLElement }).sizer.style.width;
  const w2 = (mount(env, "\t\t\t\tabcdefgh\nabcdefghijklm").view as unknown as { sizer: HTMLElement }).sizer.style.width;
  expect(w1).toBe(w2);
});

test("an empty file that is empty at HEAD shows no git markers", async () => {
  const env = await loadCodeView();
  const m = mount(env, "");
  m.view.setGit("", false);
  expect(Array.from((m.view as unknown as { gitMarks: Uint8Array }).gitMarks)).toEqual([0]);
  // Content against an empty HEAD is still all added.
  const n = mount(env, "a\nb");
  n.view.setGit("", false);
  expect(Array.from((n.view as unknown as { gitMarks: Uint8Array }).gitMarks).every((x) => x > 0)).toBe(true);
});

test("peekCurrent opens the HEAD peek on a changed active line and reports an unchanged one", async () => {
  const env = await loadCodeView();
  const m = mount(env, "a\nB\nc");
  // The fake elements lack the two layout APIs the peek box uses.
  const proto = Object.getPrototypeOf(m.view.el) as Record<string, unknown>;
  proto.insertAdjacentHTML ??= function (this: { innerHTML: string }, _p: string, html: string) {
    this.innerHTML += html;
  };
  proto.getBoundingClientRect ??= () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
  m.view.setGit("a\nb\nc", false);
  m.view.setActiveLine(0);
  expect(m.view.peekCurrent()).toBe(false);
  m.view.setActiveLine(1);
  expect(m.view.peekCurrent()).toBe(true);
  const v = m.view as unknown as { peek: { getAttribute(n: string): string | null } | null };
  expect(v.peek?.getAttribute("aria-label")).toContain("in HEAD");
  // (Closing dispatches a native Event through `dismissable`, which this harness does not model.)
});
