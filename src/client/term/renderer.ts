import { Terminal, Line, BOLD, DIM, ITALIC, UNDERLINE, INVERSE, HIDDEN, STRIKE, OVERLINE, WIDE, DEFAULT, RGB_FLAG } from "./terminal.ts";
import { isProcedural, drawProcedural } from "./boxdraw.ts";

export interface Theme {
  fg: string;
  bg: string;
  cursor: string;
  cursorText: string;
  selection: string;
  link: string;
  /** 16 ANSI colors as #rrggbb */
  ansi: string[];
}

/** What a viewport row showed when it was last painted. */
interface RowSnapshot {
  text: string[];
  fg: Int32Array;
  bg: Int32Array;
  fl: Uint32Array;
  /** Everything else that changes the row's pixels: cursor, selection, link hover, reverse video. */
  key: string;
  blank: boolean;
}

export interface Point {
  row: number; // absolute line index
  col: number;
}

/** 256-color palette: 16 theme colors, 6×6×6 cube, 24 grays. */
function buildPalette(ansi: string[]): string[] {
  const p = ansi.slice(0, 16);
  const lv = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) p.push(hex((lv[r]! << 16) | (lv[g]! << 8) | lv[b]!));
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push(hex((v << 16) | (v << 8) | v));
  }
  return p;
}

function hex(n: number): string {
  return "#" + n.toString(16).padStart(6, "0");
}

/**
 * Canvas 2D renderer. Repaints only rows whose content changed, at most once per animation
 * frame, and nothing while hidden. Cells are integer device-pixel sized so backgrounds and
 * box-drawing tile seamlessly.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  palette: string[] = [];
  theme!: Theme;
  dpr = 1;
  cw = 8; // cell width (device px)
  ch = 16; // cell height (device px)
  private baseline = 12;
  private fontSize = 13;
  private fontFamily = "monospace";
  private naturalW = 8;
  private hasLetterSpacing = false;
  private rgbCache = new Map<number, string>();
  private fonts: string[] = [];
  private frame = 0;
  private syncSince = 0;
  private prevView: (Line | undefined)[] = [];
  private prevCursorRow = -1;
  /** Per viewport row: what was painted last. TUIs redraw unchanged rows constantly; those are skipped. */
  private painted: (RowSnapshot | undefined)[] = [];
  private visible = true;
  /** Rows actually repainted (tests and diagnostics). */
  rowsPainted = 0;

  /** Scroll offset into history (0 = following output). */
  viewOffset = 0;
  selection: { a: Point; b: Point; block?: boolean } | null = null;
  hoverLink: { row: number; start: number; end: number } | null = null;
  focused = false;
  cursorOn = true;
  onFrame?: () => void;

  constructor(private term: Terminal) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "term-canvas";
    // Output reaches assistive technology through the view's live log, not the pixels.
    this.canvas.setAttribute("aria-hidden", "true");
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
  }

  setTheme(t: Theme) {
    this.theme = t;
    this.palette = buildPalette(t.ansi);
    this.invalidate();
  }

  setFont(family: string, size: number, lineHeight: number) {
    this.fontFamily = family;
    this.fontSize = size;
    this.dpr = window.devicePixelRatio || 1;
    const px = size * this.dpr;
    const ctx = this.ctx;
    this.fonts = [0, 1, 2, 3].map((v) => `${v & 2 ? "italic " : ""}${v & 1 ? "bold " : ""}${px}px ${family}`);
    this.hasLetterSpacing = "letterSpacing" in ctx;
    // Measure the natural advance with no letter-spacing, then apply the grid defaults.
    ctx.font = this.fonts[0]!;
    if (this.hasLetterSpacing) (ctx as unknown as { letterSpacing: string }).letterSpacing = "0px";
    const m = ctx.measureText("M");
    this.naturalW = m.width;
    this.cw = Math.max(1, Math.round(m.width));
    this.ch = Math.max(1, Math.round(px * lineHeight));
    const asc = m.fontBoundingBoxAscent ?? px * 0.8;
    const desc = m.fontBoundingBoxDescent ?? px * 0.2;
    this.baseline = Math.round((this.ch - (asc + desc)) / 2 + asc);
    this.ctxDefaults();
    this.term.cellPx = { w: Math.round(this.cw / this.dpr), h: Math.round(this.ch / this.dpr) };
    this.invalidate();
  }

  /** Exact characters only: no ligatures, contextual alternates or kerning in the grid. */
  private ctxDefaults() {
    const c = this.ctx as CanvasRenderingContext2D & { textRendering?: string; fontKerning?: string; letterSpacing?: string };
    c.font = this.fonts[0] ?? c.font;
    this.curFont = c.font;
    c.textRendering = "optimizeSpeed";
    c.fontKerning = "none";
    // Pads each advance to the integer cell width. Never exactly 0: any letter-spacing also
    // disables optional ligatures (WebKit has no textRendering). Set once, not per run.
    if (this.hasLetterSpacing) {
      const ls = this.cw - this.naturalW;
      c.letterSpacing = `${Math.abs(ls) < 0.01 ? 0.01 : ls}px`;
    }
    this.glyphW.clear();
  }

  private curFont = "";
  private glyphW = new Map<string, number>();

  private useFont(ctx: CanvasRenderingContext2D, font: string) {
    if (font !== this.curFont) {
      ctx.font = font;
      this.curFont = font;
    }
  }

  /** Width of a (non-ASCII) glyph in the current font, cached. */
  private glyphWidth(ctx: CanvasRenderingContext2D, t: string): number {
    const key = this.curFont + "\0" + t;
    let w = this.glyphW.get(key);
    if (w === undefined) {
      w = ctx.measureText(t).width;
      if (this.glyphW.size > 8192) this.glyphW.clear();
      this.glyphW.set(key, w);
    }
    return w;
  }

  /** Grid size that fits in a CSS-pixel box. */
  measure(width: number, height: number): { cols: number; rows: number } {
    return {
      cols: Math.max(2, Math.floor((width * this.dpr) / this.cw)),
      rows: Math.max(1, Math.floor((height * this.dpr) / this.ch)),
    };
  }

  resizeCanvas() {
    const w = this.term.cols * this.cw;
    const h = this.term.rows * this.ch;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${w / this.dpr}px`;
      this.canvas.style.height = `${h / this.dpr}px`;
      this.ctxDefaults(); // resizing a canvas resets its context state
    }
    this.invalidate();
  }

  invalidate() {
    this.prevView = [];
    this.painted = [];
    this.term.allDirty = true;
    this.schedule();
  }

  schedule() {
    if (this.visible && !this.frame) this.frame = requestAnimationFrame(() => this.paint());
  }

  /**
   * A hidden terminal (background tab, closed panel) keeps parsing its output but paints
   * nothing; it is repainted in full when shown again.
   */
  setVisible(on: boolean) {
    if (on === this.visible) return;
    this.visible = on;
    if (on) this.invalidate();
    else if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  color(c: number, isFg: boolean): string {
    if (c === DEFAULT) return isFg ? this.theme.fg : this.theme.bg;
    if (c & RGB_FLAG) {
      let s = this.rgbCache.get(c);
      if (!s) {
        s = hex(c & 0xffffff);
        if (this.rgbCache.size > 4096) this.rgbCache.clear();
        this.rgbCache.set(c, s);
      }
      return s;
    }
    return this.palette[c] ?? this.theme.fg;
  }

  private paint() {
    this.frame = 0;
    if (!this.visible) return;
    const term = this.term;
    // Synchronized output (mode 2026): hold the frame until the app finishes its update.
    if (term.modes.synchronized) {
      // Synchronized output (2026): hold the frame, but never for more than a second.
      this.syncSince ||= performance.now();
      if (performance.now() - this.syncSince < 1000) {
        setTimeout(() => this.schedule(), 16);
        return;
      }
    }
    this.syncSince = 0;
    if (term.scrolledOff) {
      if (this.viewOffset > 0) this.viewOffset = Math.min(this.viewOffset + term.scrolledOff, term.scrollback.length);
      term.scrolledOff = 0;
    }
    this.viewOffset = Math.min(this.viewOffset, term.scrollback.length);
    const ctx = this.ctx;
    const all = term.allDirty;
    const cursorRow = this.cursorVisibleRow();
    for (let y = 0; y < term.rows; y++) {
      const line = term.viewLine(y, this.viewOffset);
      const dirty =
        all ||
        (y - this.viewOffset >= 0 && term.dirty[y - this.viewOffset]) ||
        this.prevView[y] !== line ||
        y === cursorRow ||
        y === this.prevCursorRow ||
        this.rowTouchesOverlay(y);
      if (!dirty) continue;
      this.prevView[y] = line;
      const key = this.rowKey(y, line, cursorRow);
      if (this.unchanged(y, line, key)) continue;
      this.paintRow(ctx, y, line);
      this.remember(y, line, key);
    }
    this.prevCursorRow = cursorRow;
    term.dirty.fill(0);
    term.allDirty = false;
    this.onFrame?.();
  }

  /** Row state outside the cells that affects its pixels. */
  private rowKey(y: number, line: Line | undefined, cursorRow: number): string {
    if (!line) return "-";
    const term = this.term;
    const absRow = term.scrollback.length - this.viewOffset + y;
    const [s, e] = this.selectionSpan(absRow, term.cols);
    const h = this.hoverLink?.row === absRow ? `${this.hoverLink.start}-${this.hoverLink.end}` : "";
    const m = term.modes;
    const c =
      y === cursorRow && m.cursorVisible && this.viewOffset === 0
        ? `${term.cur.x}${m.cursorShape}${this.focused ? 1 : 0}${this.cursorOn ? 1 : 0}`
        : "";
    return `${m.reverseVideo ? 1 : 0}|${s},${e}|${h}|${c}`;
  }

  private unchanged(y: number, line: Line | undefined, key: string): boolean {
    const p = this.painted[y];
    if (!p || p.key !== key) return false;
    if (!line) return p.blank;
    const n = this.term.cols;
    if (p.blank || line.cols !== n || p.text.length !== n) return false;
    const { text, fg, bg, fl } = line;
    for (let x = 0; x < n; x++) {
      if (text[x] !== p.text[x] || fg[x] !== p.fg[x] || bg[x] !== p.bg[x] || fl[x] !== p.fl[x]) return false;
    }
    return true;
  }

  private remember(y: number, line: Line | undefined, key: string) {
    this.rowsPainted++;
    const n = this.term.cols;
    let p = this.painted[y];
    if (!p || p.fg.length !== n) {
      p = { text: new Array(n), fg: new Int32Array(n), bg: new Int32Array(n), fl: new Uint32Array(n), key, blank: true };
      this.painted[y] = p;
    }
    p.key = key;
    p.blank = !line || line.cols !== n;
    if (p.blank) return;
    const l = line!;
    for (let x = 0; x < n; x++) p.text[x] = l.text[x]!;
    p.fg.set(l.fg.subarray(0, n));
    p.bg.set(l.bg.subarray(0, n));
    p.fl.set(l.fl.subarray(0, n));
  }

  private overlayRows = new Set<number>();
  private rowTouchesOverlay(y: number): boolean {
    // Rows that had (or now have) a selection/link highlight must be repainted.
    return this.overlayRows.has(y);
  }

  /** Marks rows between two viewport rows for repaint (selection changes). */
  touchRows(y0: number, y1: number) {
    for (let y = Math.max(0, Math.min(y0, y1)); y <= Math.min(this.term.rows - 1, Math.max(y0, y1)); y++) this.overlayRows.add(y);
    this.schedule();
  }

  touchAll() {
    this.term.allDirty = true;
    this.schedule();
  }

  private cursorVisibleRow(): number {
    const t = this.term;
    const row = t.cur.y + this.viewOffset;
    return row < t.rows ? row : -1;
  }

  private paintRow(ctx: CanvasRenderingContext2D, y: number, line: Line | undefined) {
    const { cw, ch, term, theme } = this;
    const py = y * ch;
    const cols = term.cols;
    const rv = term.modes.reverseVideo;
    ctx.fillStyle = rv ? theme.fg : theme.bg;
    ctx.fillRect(0, py, cols * cw, ch);
    this.overlayRows.delete(y);
    if (!line) return;

    const absRow = term.scrollback.length - this.viewOffset + y;
    const [selStart, selEnd] = this.selectionSpan(absRow, cols);

    // Pass 1: backgrounds (merged runs)
    const rowFill = rv ? theme.fg : theme.bg;
    let runStart = 0;
    let runColor = "";
    for (let x = 0; x <= cols; x++) {
      let c = "";
      if (x < cols) {
        const inv = ((line.fl[x]! & INVERSE) !== 0) !== rv;
        c = inv ? this.color(line.fg[x]!, true) : this.color(line.bg[x]!, false);
        if (c === rowFill) c = "";
        if (x >= selStart && x < selEnd) c = theme.selection;
      }
      if (c !== runColor) {
        if (runColor) {
          ctx.fillStyle = runColor;
          ctx.fillRect(runStart * cw, py, (x - runStart) * cw, ch);
        }
        runColor = c;
        runStart = x;
      }
    }

    // Cursor block is drawn beneath the text so the glyph stays readable.
    const cursorRow = this.cursorVisibleRow();
    const showCursor = y === cursorRow && term.modes.cursorVisible && this.viewOffset === 0;
    const cx = term.cur.x;
    if (showCursor && this.focused && this.cursorOn && term.modes.cursorShape === "block") {
      ctx.fillStyle = theme.cursor;
      const wide = line.fl[cx]! & WIDE ? 2 : 1;
      ctx.fillRect(cx * cw, py, cw * wide, ch);
    }

    // Pass 2: text, grouped into runs of ASCII with identical style.
    ctx.textBaseline = "alphabetic";
    let x = 0;
    while (x < cols) {
      const t = line.text[x]!;
      const fl = line.fl[x]!;
      if (t === " " || t === "" || fl & HIDDEN) {
        if (fl & (UNDERLINE | STRIKE | OVERLINE) || fl >>> 16) this.decorate(ctx, line, x, py, 1);
        x++;
        continue;
      }
      const fgc = this.cellFg(line, x, showCursor && x === cx);
      const font = this.fonts[(fl & BOLD ? 1 : 0) | (fl & ITALIC ? 2 : 0)]!;
      const alpha = fl & DIM ? 0.5 : 1;
      const code = t.length === 1 ? t.charCodeAt(0) : t.codePointAt(0)!;

      if (t.length === 1 && code < 0x7f) {
        // ASCII run
        let end = x + 1;
        let s = t;
        while (end < cols) {
          const t2 = line.text[end]!;
          if (t2.length !== 1 || t2.charCodeAt(0) >= 0x7f || line.fl[end] !== fl || line.fg[end] !== line.fg[x] || line.bg[end] !== line.bg[x])
            break;
          if (showCursor && (end === cx || x === cx)) break;
          if (selStart < selEnd && (end === selStart || end === selEnd)) break;
          s += t2;
          end++;
        }
        this.useFont(ctx, font);
        ctx.fillStyle = fgc;
        ctx.globalAlpha = alpha;
        if (this.hasLetterSpacing) {
          ctx.fillText(s, x * cw, py + this.baseline);
        } else {
          for (let i = 0; i < s.length; i++) ctx.fillText(s[i]!, (x + i) * cw, py + this.baseline);
        }
        ctx.globalAlpha = 1;
        if (fl & (UNDERLINE | STRIKE | OVERLINE) || fl >>> 16) this.decorate(ctx, line, x, py, end - x);
        x = end;
        continue;
      }

      const w = fl & WIDE ? 2 : 1;
      ctx.fillStyle = fgc;
      ctx.globalAlpha = alpha;
      if (isProcedural(code)) {
        drawProcedural(ctx, code, x * cw, py, cw, ch, this.dpr);
      } else {
        this.useFont(ctx, font);
        // Squeeze glyphs from fallback fonts that are wider than their cells.
        const mw = this.glyphWidth(ctx, t) - (this.hasLetterSpacing ? this.cw - this.naturalW : 0);
        const room = cw * w;
        if (mw > room * 1.05) {
          ctx.save();
          ctx.translate(x * cw, 0);
          ctx.scale(room / mw, 1);
          ctx.fillText(t, 0, py + this.baseline);
          ctx.restore();
        } else ctx.fillText(t, x * cw + (room - mw) / 2, py + this.baseline);
      }
      ctx.globalAlpha = 1;
      if (fl & (UNDERLINE | STRIKE | OVERLINE) || fl >>> 16) this.decorate(ctx, line, x, py, w);
      x += w;
    }

    if (this.hoverLink && this.hoverLink.row === absRow) {
      ctx.fillStyle = theme.link;
      const lw = Math.max(1, Math.round(this.dpr));
      ctx.fillRect(this.hoverLink.start * cw, py + ch - lw * 2, (this.hoverLink.end - this.hoverLink.start) * cw, lw);
      this.overlayRows.add(y);
    }
    if (selStart < selEnd) this.overlayRows.add(y);

    if (showCursor && !(this.focused && this.cursorOn && term.modes.cursorShape === "block")) {
      if (!this.focused || this.cursorOn) {
        ctx.fillStyle = theme.cursor;
        ctx.strokeStyle = theme.cursor;
        const lw = Math.max(1, Math.round(this.dpr));
        const px = cx * cw;
        if (!this.focused) {
          ctx.lineWidth = lw;
          ctx.strokeRect(px + lw / 2, py + lw / 2, cw - lw, ch - lw);
        } else if (term.modes.cursorShape === "bar") ctx.fillRect(px, py, lw * 2, ch);
        else ctx.fillRect(px, py + ch - lw * 2, cw, lw * 2);
      }
    }
  }

  private cellFg(line: Line, x: number, underCursor: boolean): string {
    const fl = line.fl[x]!;
    if (underCursor && this.focused && this.cursorOn && this.term.modes.cursorShape === "block") return this.theme.cursorText;
    let fg = line.fg[x]!;
    let bg = line.bg[x]!;
    const inv = (fl & INVERSE) !== 0 !== this.term.modes.reverseVideo;
    if (inv) return bg === DEFAULT ? this.theme.bg : this.color(bg, false);
    if (fl >>> 16 && fg === DEFAULT) return this.theme.link;
    return this.color(fg, true);
  }

  private decorate(ctx: CanvasRenderingContext2D, line: Line, x: number, py: number, n: number) {
    const fl = line.fl[x]!;
    const { cw, ch } = this;
    const lw = Math.max(1, Math.round(this.dpr));
    ctx.fillStyle = this.cellFg(line, x, false);
    if (fl & UNDERLINE || fl >>> 16) {
      ctx.globalAlpha = fl & UNDERLINE ? 1 : 0.45;
      ctx.fillRect(x * cw, py + Math.min(ch - lw, this.baseline + lw * 2), n * cw, lw);
      ctx.globalAlpha = 1;
    }
    if (fl & STRIKE) ctx.fillRect(x * cw, py + Math.round(ch / 2), n * cw, lw);
    if (fl & OVERLINE) ctx.fillRect(x * cw, py, n * cw, lw);
  }

  /** Selection column span [start, end) on an absolute row. */
  private selectionSpan(row: number, cols: number): [number, number] {
    const s = this.selection;
    if (!s) return [0, 0];
    let { a, b } = s;
    if (b.row < a.row || (b.row === a.row && b.col < a.col)) [a, b] = [b, a];
    if (row < a.row || row > b.row) return [0, 0];
    if (s.block) return [Math.min(s.a.col, s.b.col), Math.max(s.a.col, s.b.col) + 1];
    const start = row === a.row ? a.col : 0;
    const end = row === b.row ? b.col + 1 : cols;
    return [start, Math.min(end, cols)];
  }

  /** Converts a CSS-pixel offset inside the canvas to a cell. */
  cellAt(px: number, py: number): { x: number; y: number } {
    const x = Math.floor((px * this.dpr) / this.cw);
    const y = Math.floor((py * this.dpr) / this.ch);
    return { x: Math.max(0, Math.min(this.term.cols - 1, x)), y: Math.max(0, Math.min(this.term.rows - 1, y)) };
  }
}
