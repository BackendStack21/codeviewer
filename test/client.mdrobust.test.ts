import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bindEditorSelectionMenu, bindSelectionMenu, selectionMenuItems, type SelectionHost } from "../src/client/copyentry.ts";
import { FONT_FACES, FONT_TABLE, isInlinableImage, snapFaces } from "../src/client/mdsnap.ts";
import type { MenuItem } from "../src/client/menu.ts";

type Snap = { id: number };

describe("AC-13 selection captured at contextmenu", () => {
  const setup = () => {
    let live: Snap | null = { id: 1 };
    const used: { op: string; snap: unknown }[] = [];
    const host: SelectionHost = {
      capture: () => live,
      hasSelection: (s) => (s === undefined ? live !== null : s !== null),
      copy: (s) => void used.push({ op: "copy", snap: s }),
      copyImage: (s) => void used.push({ op: "image", snap: s }),
    };
    let fn: ((e: MouseEvent) => void) | undefined;
    const shown: MenuItem[][] = [];
    bindSelectionMenu({ addEventListener: (_t, f) => (fn = f) }, host, (_e, items) => void shown.push(items));
    return { fire: () => fn!({} as MouseEvent), shown, used, collapse: () => (live = null) };
  };
  test("items act on the selection present at contextmenu even after it collapsed", () => {
    const s = setup();
    const captured = { id: 1 };
    s.fire();
    s.collapse();
    s.shown[0]![0]!.run();
    s.shown[0]![1]!.run();
    expect(s.used).toEqual([
      { op: "copy", snap: captured },
      { op: "image", snap: captured },
    ]);
  });
  test("a selection that is gone at contextmenu shows no menu", () => {
    const s = setup();
    s.collapse();
    s.fire();
    expect(s.shown.length).toBe(0);
  });
  test("selectionMenuItems passes an explicit snapshot to the actions", () => {
    const got: unknown[] = [];
    const items = selectionMenuItems({ hasSelection: () => true, copy: (s) => void got.push(s), copyImage: (s) => void got.push(s) }, "SNAP");
    items.forEach((i) => i.run());
    expect(got).toEqual(["SNAP", "SNAP"]);
  });
  test("a host without capture still works", () => {
    let fn: ((e: MouseEvent) => void) | undefined;
    const shown: MenuItem[][] = [];
    bindSelectionMenu({ addEventListener: (_t, f) => (fn = f) }, { hasSelection: () => true, copy() {}, copyImage() {} }, (_e, i) => void shown.push(i));
    fn!({} as MouseEvent);
    expect(shown[0]!.length).toBe(2);
  });
});

describe("SL07 R-03 real wiring", () => {
  test("bindEditorSelectionMenu binds contextmenu on the editor element with the host", () => {
    const events: string[] = [];
    let fn: ((e: MouseEvent) => void) | undefined;
    const shown: string[][] = [];
    bindEditorSelectionMenu(
      { el: { addEventListener: (t, f) => (events.push(t), (fn = f)) } },
      { hasSelection: () => true, copy() {}, copyImage() {} },
      (_e, items) => void shown.push(items.map((i) => i.label)),
    );
    expect(events).toEqual(["contextmenu"]);
    fn!({} as MouseEvent);
    expect(shown).toEqual([["Copy", "Copy as Image"]]);
  });
  test("app.ts calls it in one line and no longer binds directly", () => {
    const app = readFileSync("src/client/app.ts", "utf8");
    expect(app).toContain("bindEditorSelectionMenu(this.editor, this.selectionHost, showContextMenu)");
    expect(app).not.toContain("bindSelectionMenu(");
  });
  test("app.ts host captures at contextmenu", () => {
    const app = readFileSync("src/client/app.ts", "utf8");
    expect(app).toContain("capture:");
  });
});

describe("AC-14 font face table", () => {
  const css = readFileSync("src/client/styles.css", "utf8");
  const blocks = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]!);
  const decl = (b: string, k: string) => new RegExp(`${k}:\\s*([^;]+);`).exec(b)?.[1]!.trim().replace(/^"|"$/g, "");
  test("matches every @font-face in styles.css", () => {
    expect(blocks.length).toBe(5);
    expect(Object.keys(FONT_FACES).length).toBe(blocks.length);
    for (const b of blocks) {
      const url = /url\("([^"]+)"\)/.exec(b)![1]!;
      expect(FONT_FACES[url]).toEqual({ weight: decl(b, "font-weight")!, style: decl(b, "font-style")! });
      const fam = decl(b, "font-family")!;
      expect(FONT_TABLE[fam]).toContain(url);
    }
  });
  test("snapFaces resolves a computed family list to faces with weight and style", () => {
    const f = snapFaces('"JetBrains Mono", monospace');
    expect(f.length).toBe(4);
    expect(f.every((x) => x.family === "JetBrains Mono")).toBe(true);
    expect(f.find((x) => x.url === "/fonts/JetBrainsMono-BoldItalic.woff2")).toEqual({
      family: "JetBrains Mono",
      url: "/fonts/JetBrainsMono-BoldItalic.woff2",
      weight: "700",
      style: "italic",
    });
    expect(snapFaces("Inter")).toEqual([{ family: "Inter", url: "/fonts/InterVariable.woff2", weight: "100 900", style: "normal" }]);
    expect(snapFaces("serif")).toEqual([]);
  });
});

describe("AC-14 isInlinableImage", () => {
  const base = "http://127.0.0.1:4000/app/";
  test.each([
    ["/img/a.png", true],
    ["a.png", true],
    ["http://127.0.0.1:4000/x.png", true],
    ["data:image/png;base64,AAAA", true],
    ["http://evil.test/x.png", false],
    ["http://127.0.0.1:4001/x.png", false],
    ["//evil.test/x.png", false],
    ["javascript:alert(1)", false],
    ["file:///etc/passwd", false],
    ["https://127.0.0.1:4000/x.png", false],
  ])("%s -> %p", (src, ok) => {
    expect(isInlinableImage(src, base)).toBe(ok);
  });
  test("blob: is accepted only for the same origin", () => {
    expect(isInlinableImage("blob:http://127.0.0.1:4000/uuid", base)).toBe(true);
    expect(isInlinableImage("blob:http://evil.test/uuid", base)).toBe(false);
  });
  test("an unparsable base rejects", () => {
    expect(isInlinableImage("a.png", "not a url")).toBe(false);
  });
});
