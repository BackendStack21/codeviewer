// Pure layout of a code selection into canvas draw ops. No DOM access.
import type { Span } from "./highlight.ts";
import { normalize, type SelRange } from "./selection.ts";

export interface TokenStyle {
  bold?: boolean;
  italic?: boolean;
}
export interface ImageTheme {
  bg: string;
  fg: string;
  /** Muted foreground for the frame title; falls back to fg. */
  muted?: string;
  /** Theme accent the frame backdrop gradient derives from; falls back to fg. */
  accent?: string;
  tokenColors: Record<string, string>;
  tokenStyles?: Record<string, TokenStyle>;
  font: string;
  size: number;
}
export interface LayoutOptions {
  tabSize?: number;
  padding?: number;
  radius?: number;
  charW?: number;
  lineH?: number;
}
export interface Shadow {
  blur: number;
  offsetY: number;
  color: string;
}
export interface GradStop {
  at: number;
  color: string;
}
export type DrawOp =
  | { t: "rect"; x: number; y: number; w: number; h: number; r: number; fill: string; shadow?: Shadow }
  | { t: "gradient"; x: number; y: number; w: number; h: number; x0: number; y0: number; x1: number; y1: number; stops: GradStop[] }
  | { t: "dot"; cx: number; cy: number; r: number; fill: string }
  | { t: "text"; x: number; y: number; text: string; fill: string; bold: boolean; italic: boolean };
export interface ImageLayout {
  width: number;
  height: number;
  cols: number;
  rows: number;
  ops: DrawOp[];
  /** Set on framed layouts so the renderer draws with the theme font. */
  font?: string;
  size?: number;
}
export type LayoutResult = ImageLayout | { tooLarge: true };
export type ScaleResult = { scale: number } | { tooLarge: true };

export const MAX_PIXELS = 16_000_000;
export const MAX_ROWS = 20000;
export const MAX_COLS = 4000;

/** Scale = min(dpr, 2), reduced until w*h*scale^2 fits MAX_PIXELS; tooLarge when even scale 1 does not fit. */
export function fitScale(w: number, h: number, dpr: number): ScaleResult {
  const area = w * h;
  if (area > MAX_PIXELS) return { tooLarge: true };
  const s = Math.min(dpr, 2);
  if (area * s * s <= MAX_PIXELS) return { scale: s };
  return { scale: Math.floor(Math.sqrt(MAX_PIXELS / area) * 1000) / 1000 };
}

/** Lays out the range of `lines` (with per-line token spans) as draw ops. Deterministic. */
export function layoutImage(lines: string[], tokens: Span[][], theme: ImageTheme, range: SelRange, opts: LayoutOptions = {}): LayoutResult {
  const { start, end } = normalize(range);
  const rows = end.line - start.line + 1;
  if (rows > MAX_ROWS) return { tooLarge: true };
  const tabSize = opts.tabSize ?? 4;
  const padding = opts.padding ?? 16;
  const radius = opts.radius ?? 8;
  const charW = opts.charW ?? theme.size * 0.6;
  const lineH = opts.lineH ?? Math.round(theme.size * 1.5);
  const text: DrawOp[] = [];
  let cols = 0;
  for (let row = 0; row < rows; row++) {
    const n = start.line + row;
    const line = lines[n] ?? "";
    const toks: (string | undefined)[] = [];
    for (const [a, b, t] of tokens[n] ?? []) for (let k = a; k < b; k++) toks[k] = t;
    const c0 = Math.min(row === 0 ? start.col : 0, line.length);
    const c1 = Math.min(row === rows - 1 ? end.col : line.length, line.length);
    const y = padding + row * lineH;
    let col = 0;
    for (let i = 0; i < c0; i++) col += line[i] === "\t" ? tabSize - (col % tabSize) : 1;
    const base = col;
    let run = "";
    let runCol = 0;
    let runTok: string | undefined;
    const flush = () => {
      if (!run) return;
      const st = (runTok && theme.tokenStyles?.[runTok]) || {};
      text.push({ t: "text", x: padding + (runCol - base) * charW, y, text: run, fill: (runTok && theme.tokenColors[runTok]) || theme.fg, bold: !!st.bold, italic: !!st.italic });
      run = "";
    };
    for (let i = c0; i < c1; i++) {
      if (run && toks[i] !== runTok) flush();
      if (!run) {
        runCol = col;
        runTok = toks[i];
      }
      const w = line[i] === "\t" ? tabSize - (col % tabSize) : 1;
      run += " ".repeat(line[i] === "\t" ? w : 0) + (line[i] === "\t" ? "" : line[i]);
      col += w;
    }
    flush();
    cols = Math.max(cols, col - base);
  }
  if (cols > MAX_COLS) return { tooLarge: true };
  const width = 2 * padding + cols * charW;
  const height = 2 * padding + rows * lineH;
  return { width, height, cols, rows, ops: [{ t: "rect", x: 0, y: 0, w: width, h: height, r: radius, fill: theme.bg }, ...text] };
}
