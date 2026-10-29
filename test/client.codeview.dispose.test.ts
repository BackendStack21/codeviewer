import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, uninstallDom } from "./helpers/fakedom.ts";
import { copyEvent, fireSelectionChange, loadCodeView, mount, pressDoc, rng, type Env, type Mounted } from "./helpers/selfake.ts";

let env: Env;
beforeAll(async () => {
  env = await loadCodeView();
});
afterAll(() => uninstallDom());

const body = Array.from({ length: 300 }, (_, i) => `line ${i} text`).join("\n");
const tx = (m: Mounted, n: number) => m.row(n).querySelector("tx")!;
const DOC_EVENTS = ["keydown", "copy", "selectionchange", "mouseup", "mousemove", "mousedown"];
type Counting = { listenerCount(t: string): number };
const doc = () => env.dom.document as unknown as Counting;
const win = () => env.dom.window as unknown as Counting;
const counts = () => [...DOC_EVENTS.map((t) => doc().listenerCount(t)), win().listenerCount("blur")];
const selectAllKey = () => new FakeEvent("keydown", { key: "a", metaKey: true, target: env.dom.document.body });
/** Gives the view ownership of the shortcuts: a primary press inside its rows. */
const own = (m: Mounted) => {
  m.linesEl.dispatchEvent(new FakeEvent("mousedown", { target: tx(m, 1).parent, button: 0 }));
  env.dom.document.dispatchEvent(new FakeEvent("mouseup", { button: 0 }));
};

describe("F-1 dispose releases every global hook", () => {
  test("dispose removes all document and window listeners the view added", () => {
    const before = counts();
    const m = mount(env, body);
    const during = counts();
    expect(during.every((c, i) => c > before[i]!)).toBe(true);
    m.view.dispose();
    expect(counts()).toEqual(before);
  });

  test("a disposed view no longer reacts to selectionchange", () => {
    const m = mount(env, body);
    m.view.setRange(rng(10, 0, 12, 3));
    m.view.dispose();
    m.sel.set(tx(m, 1).childNodes[0]!, 0, tx(m, 2).childNodes[0]!, 1);
    fireSelectionChange(env);
    expect(m.view.selection).toEqual(rng(10, 0, 12, 3));
  });

  test("a disposed view no longer takes Cmd+A or copy", () => {
    const m = mount(env, body);
    own(m);
    m.view.dispose();
    const k = selectAllKey();
    env.dom.document.dispatchEvent(k);
    expect(k.defaultPrevented).toBe(false);
    expect(m.view.selection).toBeNull();
    m.view.setRange(rng(0, 0, 2, 3));
    const { e, set } = copyEvent();
    env.dom.document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(set).toEqual([]);
  });

  test("dispose cancels a pending frame", () => {
    const m = mount(env, body);
    m.view.setText(body.replace("line 1 ", "LINE 1 "), false);
    const html = m.html();
    m.view.schedule();
    m.view.dispose();
    env.flush();
    expect(m.html()).toBe(html);
    expect(m.view.frame).toBe(0);
  });

  test("dispose twice is harmless", () => {
    const m = mount(env, body);
    m.view.dispose();
    expect(() => m.view.dispose()).not.toThrow();
  });
});

describe("F-2 a detached or hidden view does not own Cmd+A and copy", () => {
  test("a visible, connected view owns Cmd+A (control)", () => {
    const m = mount(env, body);
    own(m);
    const k = selectAllKey();
    env.dom.document.dispatchEvent(k);
    expect(k.defaultPrevented).toBe(true);
    expect(m.view.selection).not.toBeNull();
    m.view.dispose();
  });

  test("a detached view does not preventDefault Cmd+A", () => {
    const m = mount(env, body);
    own(m);
    (m.view.el as { parent: { children: unknown[] } | null; remove?: () => void }).parent!.children.splice(0);
    (m.view.el as { parent: unknown }).parent = null;
    expect(m.view.el.isConnected).toBe(false);
    const k = selectAllKey();
    env.dom.document.dispatchEvent(k);
    expect(k.defaultPrevented).toBe(false);
    expect(m.view.selection).toBeNull();
    m.view.dispose();
  });

  test("a hidden view does not preventDefault Cmd+A", () => {
    const m = mount(env, body);
    own(m);
    m.view.setVisible(false);
    const k = selectAllKey();
    env.dom.document.dispatchEvent(k);
    expect(k.defaultPrevented).toBe(false);
    expect(m.view.selection).toBeNull();
    m.view.dispose();
  });

  test("a hidden view does not intercept copy when there is no live selection", () => {
    const m = mount(env, body);
    own(m);
    m.view.setRange(rng(0, 0, 2, 3));
    m.view.setVisible(false);
    const { e, set } = copyEvent();
    env.dom.document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(set).toEqual([]);
    m.view.dispose();
  });

  test("showing the view again restores ownership", () => {
    const m = mount(env, body);
    own(m);
    m.view.setVisible(false);
    m.view.setVisible(true);
    const k = selectAllKey();
    env.dom.document.dispatchEvent(k);
    expect(k.defaultPrevented).toBe(true);
    m.view.dispose();
  });

  test("a press elsewhere then Cmd+A stays with the other target (hidden view released current)", () => {
    const m = mount(env, body);
    own(m);
    m.view.setVisible(false);
    pressDoc(env, env.dom.document.body);
    const k = selectAllKey();
    env.dom.document.dispatchEvent(k);
    expect(k.defaultPrevented).toBe(false);
    m.view.dispose();
  });
});
