import { describe, expect, test } from "bun:test";
import { canvasFont, fontLoadSpecs, frameImage, glyphCells, scaledShadow } from "../src/client/imageframe.ts";
import type { DrawOp, ImageLayout, ImageTheme } from "../src/client/imagelayout.ts";

const theme: ImageTheme = { bg: "#111", fg: "#eee", muted: "#888", accent: "#4f8cff", tokenColors: {}, font: "JetBrains Mono", size: 13 };
const lay = (w: number, h: number): ImageLayout => ({ width: w, height: h, cols: 1, rows: 1, ops: [{ t: "rect", x: 0, y: 0, w, h, r: 8, fill: "#111" }] });
const txt = (text: string, bold = false, italic = false): DrawOp => ({ t: "text", x: 0, y: 0, text, fill: "#fff", bold, italic });

describe("always 2x within the pixel cap (R-01)", () => {
  test("dpr 1 and 1.5 still render at 2", () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      const r = frameImage(lay(500, 200), "a.ts", theme, (s) => s.length * 7, dpr);
      if ("tooLarge" in r) throw new Error("unexpected");
      expect(r.scale).toBe(2);
    }
  });
  test("a large frame is still reduced to fit, never below 1", () => {
    const r = frameImage(lay(3000, 3000), "a.ts", theme, (s) => s.length, 1);
    if ("tooLarge" in r) throw new Error("unexpected");
    expect(r.scale).toBeLessThan(2);
    expect(r.scale).toBeGreaterThanOrEqual(1);
  });
});

describe("scaledShadow (R-02)", () => {
  test("blur and offset scale with the canvas scale; colour is kept", () => {
    const s = { blur: 40, offsetY: 18, color: "rgba(0,0,0,0.45)" };
    expect(scaledShadow(s, 2)).toEqual({ blur: 80, offsetY: 36, color: "rgba(0,0,0,0.45)" });
    expect(scaledShadow(s, 1.5)).toEqual({ blur: 60, offsetY: 27, color: "rgba(0,0,0,0.45)" });
  });
});

describe("canvasFont (V-1)", () => {
  const tail = ', ui-monospace, Menlo, monospace';
  test("regular, bold, italic and bold-italic strings with a monospace fallback", () => {
    expect(canvasFont("JetBrains Mono", 13, false, false)).toBe(`13px "JetBrains Mono"${tail}`);
    expect(canvasFont("JetBrains Mono", 13, true, false)).toBe(`bold 13px "JetBrains Mono"${tail}`);
    expect(canvasFont("JetBrains Mono", 13, false, true)).toBe(`italic 13px "JetBrains Mono"${tail}`);
    expect(canvasFont("JetBrains Mono", 13, true, true)).toBe(`italic bold 13px "JetBrains Mono"${tail}`);
  });
  test("an already-listed family chain is kept without duplicate fallbacks", () => {
    expect(canvasFont("Menlo, monospace", 10, false, false)).toBe("10px Menlo, monospace");
  });
});

describe("fontLoadSpecs (V-1)", () => {
  test("loads every variant used, regular always first, each once", () => {
    const ops = [txt("a"), txt("b", false, true), txt("c", true, true), txt("d", false, true), txt("e", true)];
    expect(fontLoadSpecs(ops, "JetBrains Mono", 13)).toEqual([
      canvasFont("JetBrains Mono", 13, false, false),
      canvasFont("JetBrains Mono", 13, true, false),
      canvasFont("JetBrains Mono", 13, false, true),
      canvasFont("JetBrains Mono", 13, true, true),
    ]);
  });
  test("only the regular face when nothing is bold or italic; non-text ops ignored", () => {
    expect(fontLoadSpecs([{ t: "dot", cx: 0, cy: 0, r: 1, fill: "#f00" }, txt("a")], "JetBrains Mono", 13)).toEqual([canvasFont("JetBrains Mono", 13, false, false)]);
  });
});

describe("glyphCells (V-2)", () => {
  test("every non-space character gets its own grid cell", () => {
    expect(glyphCells("a===b", 100, 8)).toEqual([
      { ch: "a", x: 100 },
      { ch: "=", x: 108 },
      { ch: "=", x: 116 },
      { ch: "=", x: 124 },
      { ch: "b", x: 132 },
    ]);
  });
  test("spaces advance a cell but are not emitted", () => {
    expect(glyphCells("<= x", 0, 10)).toEqual([
      { ch: "<", x: 0 },
      { ch: "=", x: 10 },
      { ch: "x", x: 30 },
    ]);
  });
  test("a wide astral character takes two cells (shared column model)", () => {
    expect(glyphCells("a😀b", 0, 5)).toEqual([
      { ch: "a", x: 0 },
      { ch: "😀", x: 5 },
      { ch: "b", x: 15 },
    ]);
  });
  test("empty text yields nothing", () => {
    expect(glyphCells("", 5, 8)).toEqual([]);
  });
});
