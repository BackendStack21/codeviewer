import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, uninstallDom, type Dom, type FakeElement } from "./helpers/fakedom.ts";

let dom: Dom;
let m: typeof import("../src/client/menu.ts");
beforeAll(async () => {
  dom = installDom();
  m = await import("../src/client/menu.ts");
});
afterAll(() => uninstallDom());
beforeEach(() => {
  m.closeContextMenu();
  dom.document.body.replaceChildren();
  dom.window.listeners.clear();
  dom.document.activeElement = dom.document.body;
});

const mouse = (x: number, y: number) => new FakeEvent("contextmenu", { clientX: x, clientY: y }) as unknown as MouseEvent;
const key = (k: string) => new FakeEvent("keydown", { key: k });
const press = (k: string) => {
  const e = key(k);
  dom.window.dispatchEvent(e);
  return e;
};
const menuEl = () => dom.document.body.querySelector<FakeElement>(".ctx-menu");
const items = () => dom.document.body.querySelectorAll<FakeElement>(".ctx-item");

describe("context menu", () => {
  test("renders items, prevents default, positions on screen and focuses the first", () => {
    const e = mouse(30, 40);
    m.showContextMenu(e, [{ label: "Open", run() {} }, { label: "Delete", run() {} }]);
    expect(e.defaultPrevented).toBe(true);
    expect(m.isContextMenuOpen()).toBe(true);
    expect(menuEl()!.getAttribute("role")).toBe("menu");
    expect(items().map((i) => i.textContent)).toEqual(["Open", "Delete"]);
    expect(items()[0]!.getAttribute("role")).toBe("menuitem");
    expect(menuEl()!.style).toMatchObject({ left: "30px", top: "40px" });
    expect(items()[0]!.focused).toBe(true);
  });

  test("clamps near the right/bottom edge and left/top edge", () => {
    m.showContextMenu(mouse(990, 790), [{ label: "a", run() {} }]);
    expect(menuEl()!.style).toMatchObject({ left: "896px", top: "756px" }); // 1000-100-4, 800-40-4
    m.showContextMenu(mouse(-5, 0), [{ label: "a", run() {} }]);
    expect(menuEl()!.style).toMatchObject({ left: "4px", top: "4px" });
  });

  test("clicking an item closes the menu then runs it", () => {
    let openDuringRun: boolean | null = null;
    m.showContextMenu(mouse(0, 0), [{ label: "Go", run: () => (openDuringRun = m.isContextMenuOpen()) }]);
    items()[0]!.dispatchEvent(new FakeEvent("click") as unknown as Event);
    expect(openDuringRun).toBe(false);
    expect(menuEl()).toBeNull();
    expect(dom.window.listenerCount("keydown")).toBe(0);
  });

  test("opening a second menu replaces the first", () => {
    m.showContextMenu(mouse(0, 0), [{ label: "one", run() {} }]);
    m.showContextMenu(mouse(0, 0), [{ label: "two", run() {} }]);
    expect(dom.document.body.querySelectorAll(".ctx-menu").length).toBe(1);
    expect(items()[0]!.textContent).toBe("two");
  });

  test("arrow keys cycle focus with wraparound and stop propagation", () => {
    m.showContextMenu(mouse(0, 0), ["a", "b", "c"].map((label) => ({ label, run() {} })));
    const [a, b, c] = items();
    const e = press("ArrowDown");
    expect(e.defaultPrevented).toBe(true);
    expect(e.propagationStopped).toBe(true);
    expect(b!.focused).toBe(true);
    press("ArrowDown");
    expect(c!.focused).toBe(true);
    press("ArrowDown");
    expect(a!.focused).toBe(true);
    press("ArrowUp");
    expect(c!.focused).toBe(true);
    expect(m.isContextMenuOpen()).toBe(true);
  });

  test("modifier keys are ignored; Enter inside the menu is left to the button; other keys close", () => {
    m.showContextMenu(mouse(0, 0), [{ label: "a", run() {} }]);
    for (const k of ["Shift", "Control", "Alt", "Meta"]) press(k);
    expect(m.isContextMenuOpen()).toBe(true);
    const enter = press("Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(m.isContextMenuOpen()).toBe(true);
    press("x");
    expect(m.isContextMenuOpen()).toBe(false);
  });

  test("Enter with focus outside the menu is swallowed without closing", () => {
    m.showContextMenu(mouse(0, 0), [{ label: "a", run() {} }]);
    dom.document.body.focus();
    const e = press(" ");
    expect(e.defaultPrevented).toBe(true);
    expect(m.isContextMenuOpen()).toBe(true);
  });

  test("Escape and outside mousedown close; inside mousedown does not", () => {
    m.showContextMenu(mouse(0, 0), [{ label: "a", run() {} }]);
    dom.window.dispatchEvent(new FakeEvent("mousedown", { target: items()[0] }));
    expect(m.isContextMenuOpen()).toBe(true);
    dom.window.dispatchEvent(new FakeEvent("mousedown", { target: dom.document.body }));
    expect(m.isContextMenuOpen()).toBe(false);
    m.showContextMenu(mouse(0, 0), [{ label: "a", run() {} }]);
    press("Escape");
    expect(m.isContextMenuOpen()).toBe(false);
  });

  test("window blur / resize close it (transient)", () => {
    m.showContextMenu(mouse(0, 0), [{ label: "a", run() {} }]);
    dom.window.dispatchEvent(new FakeEvent("blur"));
    expect(m.isContextMenuOpen()).toBe(false);
  });

  test("focus returns to the previously focused element on close", () => {
    const btn = dom.document.createElement("button");
    dom.document.body.append(btn);
    btn.focus();
    m.showContextMenu(mouse(0, 0), [{ label: "a", run() {} }]);
    expect(btn.focused).toBe(false);
    m.closeContextMenu();
    expect(dom.document.activeElement).toBe(btn);
  });

  test("closeContextMenu is a no-op when nothing is open", () => {
    m.closeContextMenu();
    expect(m.isContextMenuOpen()).toBe(false);
  });
});
