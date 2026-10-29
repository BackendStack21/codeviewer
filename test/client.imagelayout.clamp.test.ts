import { describe, expect, test } from "bun:test";
import type { Span } from "../src/client/highlight.ts";
import { layoutImage, type DrawOp, type ImageLayout, type ImageTheme } from "../src/client/imagelayout.ts";
import type { SelRange } from "../src/client/selection.ts";

const r = (sl: number, sc: number, el: number, ec: number): SelRange => ({ start: { line: sl, col: sc }, end: { line: el, col: ec } });
const theme: ImageTheme = { bg: "#000", fg: "#fff", tokenColors: {}, font: "monospace", size: 10 };
const opts = { charW: 6, lineH: 15, padding: 10, radius: 8, tabSize: 4 };
const lay = (lines: string[], range: SelRange, tokens: Span[][] = lines.map(() => [])): ImageLayout => {
  const res = layoutImage(lines, tokens, theme, range, opts);
  if ("tooLarge" in res) throw new Error("unexpected tooLarge");
  return res;
};
const texts = (l: ImageLayout) => l.ops.filter((o): o is Extract<DrawOp, { t: "text" }> => o.t === "text");
const rowText = (l: ImageLayout, row: number) =>
  texts(l)
    .filter((o) => o.y === opts.padding + row * opts.lineH)
    .map((o) => o.text)
    .join("");

describe("column clamping (R-01)", () => {
  test("end column past the line length draws no 'undefined' and does not inflate cols", () => {
    const l = lay(["abc"], r(0, 0, 0, 50));
    expect(rowText(l, 0)).toBe("abc");
    expect(l.cols).toBe(3);
    expect(l.width).toBe(2 * 10 + 3 * 6);
  });
  test("start column past the line length yields an empty row", () => {
    const l = lay(["abc", "def"], r(0, 9, 1, 2));
    expect(rowText(l, 0)).toBe("");
    expect(rowText(l, 1)).toBe("de");
    expect(l.cols).toBe(2);
  });
  test("range extending past the last line draws empty rows without undefined", () => {
    const l = lay(["abc"], r(0, 0, 2, 4));
    expect(l.rows).toBe(3);
    expect(rowText(l, 0)).toBe("abc");
    expect(texts(l).some((o) => o.text.includes("undefined"))).toBe(false);
    expect(l.cols).toBe(3);
  });
});

describe("tab stops use the real column 0 (R-02)", () => {
  test("a partial first line keeps the editor's tab alignment", () => {
    // "ab\tx": tab after col 2 advances to col 4; selecting from col 1 keeps 'b' + 2 spaces + 'x'
    const l = lay(["ab\tx"], r(0, 1, 0, 4));
    expect(rowText(l, 0)).toBe("b  x");
    expect(texts(l).find((o) => o.text.includes("x"))).toBeDefined();
    expect(l.cols).toBe(4);
  });
  test("a tab at the start of the clipped range expands to the real stop, not a full tab", () => {
    // "abc\tx": tab at col 3 only advances 1 column
    const l = lay(["abc\tx"], r(0, 3, 0, 5));
    expect(rowText(l, 0)).toBe(" x");
    expect(l.cols).toBe(2);
  });
});
