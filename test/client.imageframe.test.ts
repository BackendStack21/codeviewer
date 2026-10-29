import { describe, expect, test } from "bun:test";
import {
  BACKDROP_PAD,
  CARD_RADIUS,
  DOT_COLORS,
  MIN_CONTENT_W,
  TITLE_BAR_H,
  basename,
  ellipsize,
  frameGeometry,
  frameImage,
  frameOps,
  type Frame,
  type FrameTheme,
} from "../src/client/imageframe.ts";
import type { DrawOp, ImageLayout, ImageTheme } from "../src/client/imagelayout.ts";

const ft: FrameTheme = { bg: "#101010", fg: "#eeeeee", muted: "#8a8a8a", accent: "#4f8cff" };
const measure = (s: string) => s.length * 7;
const geo = (w: number, h: number, title = "app.ts", t = ft, m = measure): Frame => {
  const f = frameGeometry(w, h, title, t, m);
  if ("tooLarge" in f) throw new Error("unexpected tooLarge");
  return f;
};

describe("frameGeometry (AC-6)", () => {
  test("outer size is content plus backdrop padding and title bar", () => {
    const f = geo(500, 200);
    expect(f.width).toBe(500 + 2 * BACKDROP_PAD);
    expect(f.height).toBe(200 + TITLE_BAR_H + 2 * BACKDROP_PAD);
  });
  test("design constants stay in the requested ranges", () => {
    expect(BACKDROP_PAD).toBeGreaterThanOrEqual(48);
    expect(BACKDROP_PAD).toBeLessThanOrEqual(64);
    expect(CARD_RADIUS).toBeGreaterThanOrEqual(10);
    expect(CARD_RADIUS).toBeLessThanOrEqual(12);
  });
  test("card sits inside the backdrop with theme bg, radius and a soft shadow", () => {
    const f = geo(500, 200);
    expect(f.card).toEqual({ x: BACKDROP_PAD, y: BACKDROP_PAD, w: 500, h: 200 + TITLE_BAR_H, r: CARD_RADIUS, fill: "#101010" });
    expect(f.shadow.blur).toBeGreaterThan(0);
    expect(f.shadow.offsetY).toBeGreaterThan(0);
    expect(typeof f.shadow.color).toBe("string");
  });
  test("code inset is below the title bar inside the card", () => {
    const f = geo(500, 200);
    expect(f.inset).toEqual({ x: BACKDROP_PAD, y: BACKDROP_PAD + TITLE_BAR_H });
  });
  test("three dots red/yellow/green, left to right, centred in the title bar", () => {
    const f = geo(500, 200);
    expect(f.dots.map((d) => d.fill)).toEqual([...DOT_COLORS]);
    expect(DOT_COLORS).toEqual(["#ff5f57", "#febc2e", "#28c840"]);
    const cy = BACKDROP_PAD + TITLE_BAR_H / 2;
    for (const d of f.dots) {
      expect(d.cy).toBe(cy);
      expect(d.r).toBeGreaterThan(0);
      expect(d.cx).toBeGreaterThan(BACKDROP_PAD);
    }
    expect(f.dots[0]!.cx).toBeLessThan(f.dots[1]!.cx);
    expect(f.dots[1]!.cx).toBeLessThan(f.dots[2]!.cx);
  });
  test("backdrop gradient derives from the accent and spans the canvas", () => {
    const f = geo(500, 200);
    const s = f.backdrop.stops;
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s[0]!.at).toBe(0);
    expect(s[s.length - 1]!.at).toBe(1);
    expect(s[0]!.color).toBe("#4f8cff");
    expect(s[s.length - 1]!.color).not.toBe("#4f8cff");
    expect(s[s.length - 1]!.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(geo(500, 200, "a", { ...ft, accent: "#ff0000" }).backdrop.stops).not.toEqual(s);
    const b = f.backdrop;
    expect(Math.max(b.x1, b.y1)).toBeGreaterThan(0);
    expect(b.x0).toBe(0);
    expect(b.y0).toBe(0);
  });
  test("title is centred in the card in the muted foreground", () => {
    const f = geo(500, 200, "app.ts");
    expect(f.title!.text).toBe("app.ts");
    expect(f.title!.fill).toBe("#8a8a8a");
    expect(f.title!.x).toBe(BACKDROP_PAD + 250 - measure("app.ts") / 2);
    expect(f.title!.y).toBeGreaterThanOrEqual(BACKDROP_PAD);
    expect(f.title!.y).toBeLessThan(BACKDROP_PAD + TITLE_BAR_H);
  });
  test("is deterministic", () => {
    expect(geo(500, 200)).toEqual(geo(500, 200));
  });
});

describe("minimum content width (AC-7)", () => {
  test("narrow content is clamped up to MIN_CONTENT_W", () => {
    const f = geo(50, 100);
    expect(f.card.w).toBe(MIN_CONTENT_W);
    expect(f.width).toBe(MIN_CONTENT_W + 2 * BACKDROP_PAD);
  });
  test("wider content is kept", () => {
    expect(geo(MIN_CONTENT_W + 40, 100).card.w).toBe(MIN_CONTENT_W + 40);
  });
});

describe("title (AC-8)", () => {
  test("basename strips directories of both separators", () => {
    expect(basename("src/client/app.ts")).toBe("app.ts");
    expect(basename("C:\\w\\x.py")).toBe("x.py");
    expect(basename("plain.md")).toBe("plain.md");
    expect(basename("")).toBe("");
  });
  test("frameGeometry uses the basename, not the path", () => {
    expect(geo(500, 100, "/a/b/c/readme.md").title!.text).toBe("readme.md");
  });
  test("ellipsize keeps text that fits and cuts with an ellipsis otherwise", () => {
    expect(ellipsize("abc", 100, measure)).toBe("abc");
    const out = ellipsize("abcdefghij", 50, measure);
    expect(out.endsWith("…")).toBe(true);
    expect(measure(out)).toBeLessThanOrEqual(50);
    expect(out.length).toBeGreaterThan(1);
    expect("abcdefghij".startsWith(out.slice(0, -1))).toBe(true);
  });
  test("a long basename is ellipsised to fit the title bar", () => {
    const name = "a-very-long-file-name-that-cannot-possibly-fit-in-the-bar.component.test.ts";
    const f = geo(MIN_CONTENT_W, 100, `dir/${name}`);
    expect(f.title!.text.endsWith("…")).toBe(true);
    expect(f.title!.text.length).toBeLessThan(name.length);
    expect(measure(f.title!.text)).toBeLessThan(MIN_CONTENT_W);
    const left = f.dots[2]!.cx;
    expect(f.title!.x).toBeGreaterThan(left);
    expect(f.title!.x + measure(f.title!.text)).toBeLessThanOrEqual(BACKDROP_PAD + MIN_CONTENT_W);
  });
  test("an empty title yields no title and no text op", () => {
    const f = geo(500, 100, "");
    expect(f.title).toBeUndefined();
    expect(frameOps(f).some((o) => o.t === "text")).toBe(false);
    expect(frameOps(f).filter((o) => o.t === "dot")).toHaveLength(3);
  });
});

describe("frameOps", () => {
  test("backdrop gradient first, then the card with shadow, dots and title", () => {
    const f = geo(500, 200);
    const ops = frameOps(f);
    expect(ops[0]).toEqual({ t: "gradient", x: 0, y: 0, w: f.width, h: f.height, ...f.backdrop });
    expect(ops[1]).toEqual({ t: "rect", x: f.card.x, y: f.card.y, w: f.card.w, h: f.card.h, r: f.card.r, fill: "#101010", shadow: f.shadow });
    expect(ops.filter((o) => o.t === "dot")).toEqual(f.dots.map((d) => ({ t: "dot", ...d })));
    expect(ops.find((o) => o.t === "text")).toEqual({ t: "text", x: f.title!.x, y: f.title!.y, text: "app.ts", fill: "#8a8a8a", bold: false, italic: false, whole: true });
  });
});

const it: ImageTheme = { bg: "#101010", fg: "#eeeeee", muted: "#8a8a8a", accent: "#4f8cff", tokenColors: { k: "#ff0000" }, font: "Menlo, monospace", size: 10 };
const layout = (w: number, h: number): ImageLayout => ({
  width: w,
  height: h,
  cols: 5,
  rows: 2,
  ops: [
    { t: "rect", x: 0, y: 0, w, h, r: 8, fill: "#101010" },
    { t: "text", x: 10, y: 10, text: "const", fill: "#ff0000", bold: false, italic: false },
    { t: "text", x: 10, y: 25, text: "x", fill: "#eeeeee", bold: false, italic: false },
  ],
});
const framed = (l: ImageLayout, dpr = 2, title = "a/app.ts") => {
  const r = frameImage(l, title, it, measure, dpr);
  if ("tooLarge" in r) throw new Error("unexpected tooLarge");
  return r;
};

describe("frameImage (AC-9, AC-10, AC-16)", () => {
  test("outer size and scale 2 at dpr 2", () => {
    const r = framed(layout(500, 200));
    expect(r.width).toBe(500 + 2 * BACKDROP_PAD);
    expect(r.height).toBe(200 + TITLE_BAR_H + 2 * BACKDROP_PAD);
    expect(r.scale).toBe(2);
    expect(r.cols).toBe(5);
    expect(r.rows).toBe(2);
  });
  test("scale is always 2 when it fits the pixel cap, regardless of dpr (R-01)", () => {
    expect(framed(layout(500, 200), 1).scale).toBe(2);
    expect(framed(layout(500, 200), 3).scale).toBe(2);
  });
  test("min width clamp applies to the outer size", () => {
    expect(framed(layout(50, 40)).width).toBe(MIN_CONTENT_W + 2 * BACKDROP_PAD);
  });
  test("fitScale applies to the OUTER size", () => {
    // 4000x3000 content is 12M px alone; framed it is larger and still fits at scale 1 but not 2.
    const r = framed(layout(4000, 3000));
    expect(r.width * r.height).toBeGreaterThan(12_000_000);
    expect(r.scale).toBeLessThan(2);
    expect(r.scale).toBeGreaterThanOrEqual(1);
    expect(r.width * r.height * r.scale * r.scale).toBeLessThanOrEqual(16_000_000);
  });
  test("a frame whose outer size exceeds MAX_PIXELS at scale 1 is tooLarge even if content fits", () => {
    // content 3900x3900 = 15.2M fits; outer (4012 x 4048) = 16.2M does not.
    expect(frameImage(layout(3900, 3900), "a.ts", it, measure, 2)).toEqual({ tooLarge: true });
    expect(frameImage(layout(5000, 4000), "a.ts", it, measure, 1)).toEqual({ tooLarge: true });
  });
  test("code ops are offset by the card inset; the layout's own backdrop rect is dropped", () => {
    const r = framed(layout(500, 200));
    const texts = r.ops.filter((o): o is Extract<DrawOp, { t: "text" }> => o.t === "text" && o.text !== "app.ts");
    expect(texts.map((o) => [o.text, o.x, o.y])).toEqual([
      ["const", 10 + BACKDROP_PAD, 10 + BACKDROP_PAD + TITLE_BAR_H],
      ["x", 10 + BACKDROP_PAD, 25 + BACKDROP_PAD + TITLE_BAR_H],
    ]);
    const rects = r.ops.filter((o) => o.t === "rect");
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ fill: "#101010", r: CARD_RADIUS, x: BACKDROP_PAD, y: BACKDROP_PAD });
  });
  test("token fills and default fg are preserved; font and size travel with the result", () => {
    const r = framed(layout(500, 200));
    expect(r.ops.find((o) => o.t === "text" && o.text === "const")).toMatchObject({ fill: "#ff0000" });
    expect(r.ops.find((o) => o.t === "text" && o.text === "x")).toMatchObject({ fill: "#eeeeee" });
    expect(r.font).toBe("Menlo, monospace");
    expect(r.size).toBe(10);
  });
  test("the frame ops come first, the title is the basename", () => {
    const r = framed(layout(500, 200));
    expect(r.ops[0]!.t).toBe("gradient");
    expect(r.ops.some((o) => o.t === "text" && o.text === "app.ts")).toBe(true);
  });
  test("accent and muted fall back to fg when the theme has none", () => {
    const bare: ImageTheme = { ...it, accent: undefined, muted: undefined };
    const r = frameImage(layout(500, 200), "a.ts", bare, measure, 2);
    if ("tooLarge" in r) throw new Error("unexpected");
    const g = r.ops[0] as Extract<DrawOp, { t: "gradient" }>;
    expect(g.stops[0]!.color).toBe("#eeeeee");
    expect(r.ops.find((o) => o.t === "text" && o.text === "a.ts")).toMatchObject({ fill: "#eeeeee" });
  });
});
