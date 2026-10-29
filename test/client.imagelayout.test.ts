import { describe, expect, test } from "bun:test";
import type { Span } from "../src/client/highlight.ts";
import { fitScale, layoutImage, type DrawOp, type ImageLayout, type ImageTheme } from "../src/client/imagelayout.ts";
import type { SelRange } from "../src/client/selection.ts";

const r = (sl: number, sc: number, el: number, ec: number): SelRange => ({ start: { line: sl, col: sc }, end: { line: el, col: ec } });
const theme: ImageTheme = {
  bg: "#101010",
  fg: "#eeeeee",
  tokenColors: { k: "#ff0000", s: "#00ff00", c: "#888888" },
  tokenStyles: { k: { bold: true }, c: { italic: true } },
  font: "Menlo, monospace",
  size: 10,
};
const opts = { charW: 6, lineH: 15, padding: 10, radius: 8, tabSize: 4 };
const lay = (lines: string[], tokens: Span[][], range: SelRange, o = opts): ImageLayout => {
  const res = layoutImage(lines, tokens, theme, range, o);
  if ("tooLarge" in res) throw new Error("unexpected tooLarge");
  return res;
};
const texts = (l: ImageLayout) => l.ops.filter((o): o is Extract<DrawOp, { t: "text" }> => o.t === "text");
const rowText = (l: ImageLayout, row: number) =>
  texts(l)
    .filter((o) => o.y === opts.padding + row * opts.lineH)
    .map((o) => o.text)
    .join("");

describe("layoutImage (AC-4)", () => {
  const lines = ["const a = 'x'; // hi", "\treturn a", "tail"];
  const tokens: Span[][] = [
    [
      [0, 5, "k"],
      [10, 13, "s"],
      [15, 20, "c"],
    ],
    [[1, 7, "k"]],
    [],
  ];

  test("first op is a rounded background rect covering the canvas in theme bg", () => {
    const l = lay(lines, tokens, r(0, 0, 2, 4));
    expect(l.ops[0]).toEqual({ t: "rect", x: 0, y: 0, w: l.width, h: l.height, r: 8, fill: "#101010" });
  });

  test("canvas size is padding + cols*charW by padding + rows*lineH", () => {
    const l = lay(["abcd", "abcdefghij"], [[], []], r(0, 0, 1, 10));
    expect(l.cols).toBe(10);
    expect(l.rows).toBe(2);
    expect(l.width).toBe(2 * 10 + 10 * 6);
    expect(l.height).toBe(2 * 10 + 2 * 15);
  });

  test("token runs use the theme colour, untokenized text uses fg", () => {
    const l = lay(lines, tokens, r(0, 0, 0, 20));
    const kw = texts(l).find((o) => o.text === "const")!;
    expect(kw.fill).toBe("#ff0000");
    expect(kw.x).toBe(10);
    expect(kw.y).toBe(10);
    const str = texts(l).find((o) => o.text === "'x'")!;
    expect(str.fill).toBe("#00ff00");
    expect(str.x).toBe(10 + 10 * 6);
    const gap = texts(l).find((o) => o.text.includes("a ="))!;
    expect(gap.fill).toBe("#eeeeee");
    expect(rowText(l, 0)).toBe("const a = 'x'; // hi");
  });

  test("bold and italic come from the token style", () => {
    const l = lay(lines, tokens, r(0, 0, 0, 20));
    const kw = texts(l).find((o) => o.text === "const")!;
    expect(kw.bold).toBe(true);
    expect(kw.italic).toBe(false);
    const cm = texts(l).find((o) => o.text === "// hi")!;
    expect(cm.italic).toBe(true);
    expect(cm.bold).toBe(false);
    const gap = texts(l).find((o) => o.text.includes("a ="))!;
    expect(gap.bold).toBe(false);
    expect(gap.italic).toBe(false);
  });

  test("tabs expand to tab stops and no tab character is drawn", () => {
    const l = lay(lines, tokens, r(1, 0, 1, 9));
    expect(texts(l).some((o) => o.text.includes("\t"))).toBe(false);
    const ret = texts(l).find((o) => o.text === "return")!;
    expect(ret.x).toBe(10 + 4 * 6);
    expect(l.cols).toBe(4 + 8);
    const l2 = lay(["ab\tx"], [[]], r(0, 0, 0, 4));
    expect(l2.cols).toBe(5);
    expect(rowText(l2, 0)).toBe("ab  x");
  });

  test("first and last lines are clipped to the range columns", () => {
    const l = lay(lines, tokens, r(0, 6, 2, 2));
    expect(l.rows).toBe(3);
    expect(rowText(l, 0)).toBe("a = 'x'; // hi");
    expect(rowText(l, 2)).toBe("ta");
    const str = texts(l).find((o) => o.text === "'x'")!;
    expect(str.x).toBe(10 + 4 * 6);
  });

  test("a clipped token keeps its colour", () => {
    const l = lay(lines, tokens, r(0, 2, 0, 4));
    const part = texts(l).find((o) => o.text === "ns")!;
    expect(part.fill).toBe("#ff0000");
  });

  test("reversed range gives the same layout as the normalised one", () => {
    expect(lay(lines, tokens, r(2, 2, 0, 6))).toEqual(lay(lines, tokens, r(0, 6, 2, 2)));
  });

  test("no line numbers by default: only the rect and the line text are drawn", () => {
    const l = lay(["ab", "cd"], [[], []], r(0, 0, 1, 2));
    expect(rowText(l, 0)).toBe("ab");
    expect(rowText(l, 1)).toBe("cd");
    expect(texts(l).every((o) => o.x >= 10)).toBe(true);
    expect(l.ops.filter((o) => o.t === "rect")).toHaveLength(1);
  });

  test("identical input yields identical ops", () => {
    expect(lay(lines, tokens, r(0, 0, 2, 4))).toEqual(lay(lines, tokens, r(0, 0, 2, 4)));
  });

  test("defaults derive charW/lineH from the font size", () => {
    const res = layoutImage(["abcd"], [[]], theme, r(0, 0, 0, 4));
    if ("tooLarge" in res) throw new Error("unexpected");
    expect(res.width).toBeGreaterThan(0);
    expect(res.height).toBeGreaterThan(res.rows * theme.size - 1);
  });

  test("empty lines inside the range occupy a row", () => {
    const l = lay(["a", "", "b"], [[], [], []], r(0, 0, 2, 1));
    expect(l.rows).toBe(3);
    expect(rowText(l, 2)).toBe("b");
  });
});

describe("size caps (AC-7)", () => {
  test("more than 20000 rows is tooLarge", () => {
    const lines = Array.from({ length: 20001 }, () => "x");
    expect(layoutImage(lines, lines.map(() => []), theme, r(0, 0, 20000, 1), opts)).toEqual({ tooLarge: true });
  });
  test("exactly 20000 rows is allowed", () => {
    const lines = Array.from({ length: 20000 }, () => "x");
    expect("tooLarge" in layoutImage(lines, lines.map(() => []), theme, r(0, 0, 19999, 1), opts)).toBe(false);
  });
  test("more than 4000 columns is tooLarge", () => {
    const lines = ["x".repeat(4001)];
    expect(layoutImage(lines, [[]], theme, r(0, 0, 0, 4001), opts)).toEqual({ tooLarge: true });
  });
});

describe("fitScale (AC-7)", () => {
  test("uses dpr when small", () => {
    expect(fitScale(100, 100, 1)).toEqual({ scale: 1 });
    expect(fitScale(100, 100, 1.5)).toEqual({ scale: 1.5 });
  });
  test("caps dpr at 2", () => {
    expect(fitScale(100, 100, 3)).toEqual({ scale: 2 });
  });
  test("reduces the scale so the area fits 16M pixels", () => {
    const res = fitScale(3000, 3000, 2);
    if (!("scale" in res)) throw new Error("expected scale");
    expect(res.scale).toBeLessThan(2);
    expect(res.scale).toBeGreaterThanOrEqual(1);
    expect(3000 * 3000 * res.scale * res.scale).toBeLessThanOrEqual(16_000_000);
  });
  test("a size that cannot fit at scale 1 is tooLarge", () => {
    expect(fitScale(5000, 4000, 1)).toEqual({ tooLarge: true });
  });
  test("exactly 16M pixels fits at scale 1", () => {
    expect(fitScale(4000, 4000, 2)).toEqual({ scale: 1 });
  });
});
