import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bindSelectionMenu, copyImageCommand, selectionMenuItems, type SelectionHost } from "../src/client/copyentry.ts";
import type { MenuItem } from "../src/client/menu.ts";

const host = (sel: boolean) => {
  const h = { copies: 0, images: 0, hasSelection: () => sel, copy: () => void h.copies++, copyImage: () => void h.images++ };
  return h satisfies SelectionHost & object;
};

describe("AC-6 selection menu items", () => {
  test("with a selection: Copy then Copy as Image, each wired to its action", () => {
    const h = host(true);
    const items = selectionMenuItems(h);
    expect(items.map((i) => i.label)).toEqual(["Copy", "Copy as Image"]);
    items[0]!.run();
    expect(h.copies).toBe(1);
    expect(h.images).toBe(0);
    items[1]!.run();
    expect(h.images).toBe(1);
  });
  test("without a selection: no items", () => {
    expect(selectionMenuItems(host(false))).toEqual([]);
  });
});

describe("AC-6 bindSelectionMenu", () => {
  const setup = (sel: boolean) => {
    let fn: ((e: MouseEvent) => void) | undefined;
    let type = "";
    const shown: MenuItem[][] = [];
    bindSelectionMenu({ addEventListener: (t, f) => ((type = t), (fn = f)) }, host(sel), (_e, items) => void shown.push(items));
    return { type, fire: () => fn!({ preventDefault() {} } as unknown as MouseEvent), shown };
  };
  test("contextmenu with a selection shows the two items", () => {
    const s = setup(true);
    expect(s.type).toBe("contextmenu");
    s.fire();
    expect(s.shown.length).toBe(1);
    expect(s.shown[0]!.map((i) => i.label)).toEqual(["Copy", "Copy as Image"]);
  });
  test("contextmenu without a selection leaves the default menu alone", () => {
    const s = setup(false);
    expect(s.type).toBe("contextmenu");
    s.fire();
    expect(s.shown.length).toBe(0);
  });
});

describe("AC-6 palette command", () => {
  test("id, label, keys and action", () => {
    const h = host(true);
    const c = copyImageCommand(h, "⌘⇧C");
    expect(c.id).toBe("selection.copyImage");
    expect(c.label).toBe("Copy Selection as Image");
    expect(c.keys).toBe("⌘⇧C");
    c.run();
    expect(h.images).toBe(1);
  });
});

describe("AC-9 docs", () => {
  for (const f of ["README.md", "DESIGN.md"]) {
    test(`${f} mentions Copy as Image and the shortcut`, () => {
      const t = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      expect(t).toContain("Copy as Image");
      expect(/Shift\+C|⌘⇧C/.test(t)).toBe(true);
    });
  }
});
