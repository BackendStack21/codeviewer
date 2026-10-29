import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildSvg, cssSafe, fontFaceUrls, pairTrees, snapSize, type TreeNode } from "../src/client/mdsnap.ts";
import { installDom, uninstallDom } from "./helpers/fakedom.ts";

const table = {
  "JetBrains Mono": ["/fonts/JetBrainsMono-Regular.woff2", "/fonts/JetBrainsMono-Bold.woff2"],
  Inter: ["/fonts/InterVariable.woff2"],
};

describe("R-01 fontFaceUrls", () => {
  test("maps the families in a computed font-family list to every url in the table", () => {
    const r = fontFaceUrls('"JetBrains Mono", Inter, monospace', table);
    expect(r).toEqual([
      { family: "JetBrains Mono", url: "/fonts/JetBrainsMono-Regular.woff2" },
      { family: "JetBrains Mono", url: "/fonts/JetBrainsMono-Bold.woff2" },
      { family: "Inter", url: "/fonts/InterVariable.woff2" },
    ]);
  });
  test("strips quotes, ignores case and unknown families", () => {
    expect(fontFaceUrls("'inter', Arial", table)).toEqual([{ family: "Inter", url: "/fonts/InterVariable.woff2" }]);
    expect(fontFaceUrls("Arial, serif", table)).toEqual([]);
  });
});

describe("R-02 snapSize", () => {
  test("is the union of the rects plus padding on all sides", () => {
    const r = snapSize(
      [
        { left: 10, top: 20, right: 110, bottom: 40 },
        { left: 5, top: 40, right: 60, bottom: 90 },
      ],
      8,
    );
    expect(r).toEqual({ width: 105 + 16, height: 70 + 16 });
  });
  test("no rects gives zero size", () => {
    expect(snapSize([], 8)).toEqual({ width: 0, height: 0 });
  });
});

describe("R-04 pairTrees", () => {
  const n = (...children: TreeNode[]): TreeNode => ({ children });
  test("pairs parallel trees in pre-order, roots included", () => {
    const a = n(n(n()), n());
    const b = n(n(n()), n());
    const pairs = pairTrees(a, b);
    expect(pairs.length).toBe(4);
    expect(pairs[0]).toEqual([a, b]);
    expect(pairs[1]![0]).toBe(a.children[0]!);
    expect(pairs[1]![1]).toBe(b.children[0]!);
    expect(pairs[2]![0]).toBe(a.children[0]!.children[0]!);
    expect(pairs[3]![1]).toBe(b.children[1]!);
  });
  test("a child-count mismatch pairs only the common children, never misaligning", () => {
    const a = n(n(), n(), n());
    const b = n(n(), n());
    const pairs = pairTrees(a, b);
    expect(pairs.length).toBe(3);
    for (const [l, c] of pairs) expect(l === a ? c === b : a.children.indexOf(l) === b.children.indexOf(c)).toBe(true);
  });
});

describe("R-06 cssSafe", () => {
  test("removes braces and markup openers from css text", () => {
    const out = cssSafe("color:red}body{background:url(x)</style>");
    expect(out).not.toContain("}");
    expect(out).not.toContain("{");
    expect(out).not.toContain("<");
    expect(out).toContain("color:red");
  });
  test("leaves ordinary declarations alone", () => {
    expect(cssSafe("color:red;margin:0 1px")).toBe("color:red;margin:0 1px");
  });
  test("buildSvg never lets a style value close its rule", () => {
    const svg = buildSvg({ html: "", styles: { p: "color:red}body{x:y" }, fonts: [], width: 1, height: 1, bg: "#000" });
    expect(svg).toContain("p{color:red");
    expect((svg.match(/}/g) ?? []).length).toBe(1);
  });
});

describe("R-05 MarkdownView.selectionRange", () => {
  let V: typeof import("../src/client/mdview.ts");
  beforeAll(async () => {
    installDom();
    V = await import("../src/client/mdview.ts");
  });
  afterAll(() => uninstallDom());
  const setSel = (sel: unknown) => {
    (globalThis as unknown as { window: { getSelection: () => unknown } }).window.getSelection = () => sel;
  };
  test("returns the range when it lies inside the view", () => {
    const v = new V.MarkdownView("hello");
    const range = { commonAncestorContainer: v.el };
    setSel({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range });
    expect(v.selectionRange()).toBe(range as unknown as Range);
  });
  test("null when collapsed, empty, outside the view or unsupported", () => {
    const v = new V.MarkdownView("hello");
    const outside = { commonAncestorContainer: document.createElement("div") };
    setSel({ rangeCount: 1, isCollapsed: true, getRangeAt: () => ({ commonAncestorContainer: v.el }) });
    expect(v.selectionRange()).toBeNull();
    setSel({ rangeCount: 0, isCollapsed: false, getRangeAt: () => outside });
    expect(v.selectionRange()).toBeNull();
    setSel({ rangeCount: 1, isCollapsed: false, getRangeAt: () => outside });
    expect(v.selectionRange()).toBeNull();
    setSel(null);
    expect(v.selectionRange()).toBeNull();
  });
});
