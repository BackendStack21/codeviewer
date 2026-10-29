import { describe, expect, test } from "bun:test";
import { BACKDROP_PAD, MIN_CONTENT_W, TITLE_BAR_H, frameGeometry, frameOps, frameSnapshot, glyphCells } from "../src/client/imageframe.ts";
import { layoutImage, type DrawOp, type ImageTheme } from "../src/client/imagelayout.ts";

const theme: ImageTheme = { bg: "#101010", fg: "#eeeeee", muted: "#8a8a8a", accent: "#4f8cff", tokenColors: { k: "#f00", s: "#0f0" }, font: "JetBrains Mono", size: 10 };
const measure = (s: string) => s.length * 7;
const ft = { bg: theme.bg, fg: theme.fg, muted: theme.muted!, accent: theme.accent! };

function snap(w: number, h: number, title = "/x/doc.md", dpr = 1) {
  const r = frameSnapshot(w, h, title, theme, measure, dpr);
  expect("tooLarge" in r).toBe(false);
  return r as Exclude<typeof r, { tooLarge: true }>;
}

describe("frameSnapshot (AC-11)", () => {
  test("wraps the PNG with the same geometry and ops as the code frame", () => {
    const r = snap(500, 200);
    const g = frameGeometry(500, 200, "/x/doc.md", ft, measure);
    if ("tooLarge" in g) throw new Error("tooLarge");
    expect(r.width).toBe(500 + 2 * BACKDROP_PAD);
    expect(r.height).toBe(200 + TITLE_BAR_H + 2 * BACKDROP_PAD);
    expect(r.ops).toEqual(frameOps(g));
    expect(r.image).toEqual({ x: BACKDROP_PAD, y: BACKDROP_PAD + TITLE_BAR_H, w: 500, h: 200 });
    expect((r.ops as DrawOp[]).some((o) => o.t === "text" && o.text === "doc.md")).toBe(true);
  });
  test("an image narrower than the minimum card is centred in the clamped card", () => {
    const r = snap(200, 100);
    expect(r.width).toBe(MIN_CONTENT_W + 2 * BACKDROP_PAD);
    expect(r.image.x).toBe(BACKDROP_PAD + (MIN_CONTENT_W - 200) / 2);
    expect(r.image.w).toBe(200);
  });
  test("always 2x unless the pixel cap forces a reduction; tooLarge past the cap", () => {
    expect(snap(500, 200, "a.md", 1).scale).toBe(2);
    const big = snap(3000, 3000);
    expect(big.scale).toBeLessThan(2);
    expect(big.scale).toBeGreaterThanOrEqual(1);
    expect("tooLarge" in frameSnapshot(9000, 9000, "a.md", theme, measure, 2)).toBe(true);
  });
});

describe("one column model for layout and drawing (R-05)", () => {
  test("glyphCells: a wide astral character advances two cells", () => {
    expect(glyphCells("😀ab", 0, 10)).toEqual([
      { ch: "😀", x: 0 },
      { ch: "a", x: 20 },
      { ch: "b", x: 30 },
    ]);
  });
  test("glyphCells: wide CJK advances two cells, a combining mark none", () => {
    expect(glyphCells("中b", 0, 10)).toEqual([
      { ch: "中", x: 0 },
      { ch: "b", x: 20 },
    ]);
    expect(glyphCells("éx", 0, 10)).toEqual([
      { ch: "e", x: 0 },
      { ch: "́", x: 10 },
      { ch: "x", x: 10 },
    ]);
  });
  const tops = (line: string, tokens: [number, number, string][]) => {
    const l = layoutImage([line], [tokens], theme, { start: { line: 0, col: 0 }, end: { line: 0, col: line.length } }, { charW: 10, padding: 0 });
    if ("tooLarge" in l) throw new Error("tooLarge");
    return { l, texts: l.ops.filter((o): o is Extract<DrawOp, { t: "text" }> => o.t === "text") };
  };
  test("layoutImage: a narrow astral character (2 UTF-16 units) is one column", () => {
    const { l, texts } = tops("\u{1d4b3}b", [[0, 2, "k"], [2, 3, "s"]]);
    expect(texts.map((t) => [t.text, t.x])).toEqual([["\u{1d4b3}", 0], ["b", 10]]);
    expect(l.cols).toBe(2);
  });
  test("layoutImage: an emoji and CJK take two columns, so the next run lines up with glyphCells", () => {
    const e = tops("😀ab", [[0, 2, "k"], [2, 4, "s"]]);
    expect(e.texts.map((t) => [t.text, t.x])).toEqual([["😀", 0], ["ab", 20]]);
    expect(e.l.cols).toBe(4);
    const run = e.texts[1]!;
    expect(glyphCells("😀ab", 0, 10).filter((g) => g.ch === "a")[0]!.x).toBe(run.x);
    const c = tops("中b", [[0, 1, "k"], [1, 2, "s"]]);
    expect(c.texts.map((t) => [t.text, t.x])).toEqual([["中", 0], ["b", 20]]);
    expect(c.l.cols).toBe(3);
  });
  test("layoutImage: a selection starting after an emoji offsets by its columns", () => {
    const line = "😀ab";
    const l = layoutImage([line], [[[2, 4, "s"]]], theme, { start: { line: 0, col: 2 }, end: { line: 0, col: 4 } }, { charW: 10, padding: 0 });
    if ("tooLarge" in l) throw new Error("tooLarge");
    expect(l.cols).toBe(2);
  });
});
