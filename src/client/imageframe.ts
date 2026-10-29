// Pure geometry of the snippet frame (backdrop, window card, title bar). No DOM access.
import { fitScale, MAX_PIXELS, type DrawOp, type GradStop, type ImageLayout, type ImageTheme, type Shadow } from "./imagelayout.ts";

export const BACKDROP_PAD = 56;
export const TITLE_BAR_H = 36;
export const CARD_RADIUS = 11;
export const MIN_CONTENT_W = 360;
export const DOT_COLORS = ["#ff5f57", "#febc2e", "#28c840"] as const;

export type Measure = (text: string) => number;
export interface FrameTheme {
  bg: string;
  fg: string;
  muted: string;
  accent: string;
}
export interface Frame {
  width: number;
  height: number;
  card: { x: number; y: number; w: number; h: number; r: number; fill: string };
  /** Where the code content's top-left lands on the canvas. */
  inset: { x: number; y: number };
  shadow: Shadow;
  dots: { cx: number; cy: number; r: number; fill: string }[];
  backdrop: { x0: number; y0: number; x1: number; y1: number; stops: GradStop[] };
  title?: { text: string; x: number; y: number; fill: string };
}
export type FrameResult = Frame | { tooLarge: true };
export type FramedImage = ImageLayout & { scale: number };
export type FramedResult = FramedImage | { tooLarge: true };

const TITLE_SIDE = 76;
const DOT_R = 6;
const DOT_GAP = 20;
const DOT_X0 = 20;
const TITLE_Y = 12;
const SHADOW: Shadow = { blur: 40, offsetY: 18, color: "rgba(0,0,0,0.45)" };

export function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** Shortens `text` with a trailing "…" until it fits `maxW`. */
export function ellipsize(text: string, maxW: number, measure: Measure): string {
  if (measure(text) <= maxW) return text;
  let n = text.length - 1;
  while (n > 0 && measure(text.slice(0, n) + "…") > maxW) n--;
  return text.slice(0, n) + "…";
}

/** Darkens a #rgb/#rrggbb colour toward black; other formats are returned unchanged. */
function darken(color: string, k: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const h = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
  const ch = [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * k));
  return "#" + ch.map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function frameGeometry(contentW: number, contentH: number, title: string, theme: FrameTheme, measure: Measure): FrameResult {
  const cw = Math.max(contentW, MIN_CONTENT_W);
  const width = cw + 2 * BACKDROP_PAD;
  const height = contentH + TITLE_BAR_H + 2 * BACKDROP_PAD;
  if (width * height > MAX_PIXELS) return { tooLarge: true };
  const name = basename(title);
  const text = name ? ellipsize(name, cw - 2 * TITLE_SIDE, measure) : "";
  const frame: Frame = {
    width,
    height,
    card: { x: BACKDROP_PAD, y: BACKDROP_PAD, w: cw, h: contentH + TITLE_BAR_H, r: CARD_RADIUS, fill: theme.bg },
    inset: { x: BACKDROP_PAD, y: BACKDROP_PAD + TITLE_BAR_H },
    shadow: SHADOW,
    dots: DOT_COLORS.map((fill, i) => ({ cx: BACKDROP_PAD + DOT_X0 + i * DOT_GAP, cy: BACKDROP_PAD + TITLE_BAR_H / 2, r: DOT_R, fill })),
    backdrop: {
      x0: 0,
      y0: 0,
      x1: width,
      y1: height,
      stops: [
        { at: 0, color: theme.accent },
        { at: 1, color: darken(theme.accent, 0.35) },
      ],
    },
  };
  if (text) frame.title = { text, x: BACKDROP_PAD + cw / 2 - measure(text) / 2, y: BACKDROP_PAD + TITLE_Y, fill: theme.muted };
  return frame;
}

export function frameOps(frame: Frame): DrawOp[] {
  const c = frame.card;
  const ops: DrawOp[] = [
    { t: "gradient", x: 0, y: 0, w: frame.width, h: frame.height, ...frame.backdrop },
    { t: "rect", x: c.x, y: c.y, w: c.w, h: c.h, r: c.r, fill: c.fill, shadow: frame.shadow },
    ...frame.dots.map((d) => ({ t: "dot" as const, ...d })),
  ];
  if (frame.title) ops.push({ t: "text", x: frame.title.x, y: frame.title.y, text: frame.title.text, fill: frame.title.fill, bold: false, italic: false });
  return ops;
}

/** Wraps a laid-out code image (always 2x, reduced only to fit the pixel cap; dpr is not consulted) in the frame: offsets its text into the card and fits the scale to the outer size. */
export function frameImage(layout: ImageLayout, title: string, theme: ImageTheme, measure: Measure, _dpr: number): FramedResult {
  const ft: FrameTheme = { bg: theme.bg, fg: theme.fg, muted: theme.muted ?? theme.fg, accent: theme.accent ?? theme.fg };
  const frame = frameGeometry(layout.width, layout.height, title, ft, measure);
  if ("tooLarge" in frame) return frame;
  const fit = fitScale(frame.width, frame.height, 2);
  if ("tooLarge" in fit) return fit;
  const code = layout.ops
    .filter((o) => o.t === "text")
    .map((o) => ({ ...o, x: o.x + frame.inset.x, y: o.y + frame.inset.y }));
  return { width: frame.width, height: frame.height, cols: layout.cols, rows: layout.rows, ops: [...frameOps(frame), ...code], font: theme.font, size: theme.size, ...(layout.charW ? { charW: layout.charW } : {}), scale: fit.scale };
}

/** Shadow blur/offset in device pixels for a canvas drawn at `scale` (ctx.shadow* ignores ctx.scale). */
export function scaledShadow(shadow: Shadow, scale: number): Shadow {
  return { blur: shadow.blur * scale, offsetY: shadow.offsetY * scale, color: shadow.color };
}

const FALLBACK = "ui-monospace, Menlo, monospace";

/** Canvas font shorthand with a monospace fallback chain. */
export function canvasFont(font: string, size: number, bold: boolean, italic: boolean): string {
  const family = /[,"']/.test(font) ? font : `"${font}", ${FALLBACK}`;
  return `${italic ? "italic " : ""}${bold ? "bold " : ""}${size}px ${family}`;
}

/** Distinct canvas font strings the ops need loaded (regular first, then bold, italic, bold-italic when used). */
export function fontLoadSpecs(ops: DrawOp[], font: string, size: number): string[] {
  const used = new Set<string>(["00"]);
  for (const o of ops) if (o.t === "text") used.add(`${o.bold ? 1 : 0}${o.italic ? 1 : 0}`);
  return ["00", "10", "01", "11"].filter((k) => used.has(k)).map((k) => canvasFont(font, size, k[0] === "1", k[1] === "1"));
}

/** One entry per drawn glyph at x + cell * charW (spaces occupy a cell but are not drawn). */
export function glyphCells(text: string, x: number, charW: number): { ch: string; x: number }[] {
  const out: { ch: string; x: number }[] = [];
  let i = 0;
  for (const ch of text) {
    if (ch !== " ") out.push({ ch, x: x + i * charW });
    i++;
  }
  return out;
}
