import { charWidth } from "./width.ts";

// Cell attribute flags (low 16 bits). The high 16 bits carry an OSC 8 hyperlink id.
export const BOLD = 1,
  DIM = 2,
  ITALIC = 4,
  UNDERLINE = 8,
  BLINK = 16,
  INVERSE = 32,
  HIDDEN = 64,
  STRIKE = 128,
  OVERLINE = 256,
  WIDE = 512;
const STYLE_MASK = 0x1ff;

/** Colors: -1 = default, 0..255 = palette, RGB_FLAG|0xRRGGBB = truecolor. */
export const DEFAULT = -1;
export const RGB_FLAG = 0x1000000;

export class Line {
  text: string[];
  fg: Int32Array;
  bg: Int32Array;
  fl: Uint32Array;
  /** True when this line soft-wraps into the next one. */
  wrapped = false;
  /** High-water mark: cells at or beyond `hw` are guaranteed blank (default attributes). */
  hw = 0;
  /** True once the line was reported through `onLine` (cleared by any later print). */
  spoken = false;

  constructor(cols: number, bg = DEFAULT) {
    this.text = new Array(cols).fill(" ");
    this.fg = new Int32Array(cols).fill(DEFAULT);
    this.bg = new Int32Array(cols).fill(bg);
    this.fl = new Uint32Array(cols);
    if (bg !== DEFAULT) this.hw = cols;
  }

  get cols() {
    return this.text.length;
  }

  resize(cols: number) {
    const old = this.text.length;
    if (cols === old) return;
    if (cols < old) {
      this.text.length = cols;
      this.fg = this.fg.slice(0, cols);
      this.bg = this.bg.slice(0, cols);
      this.fl = this.fl.slice(0, cols);
      if (cols > 0 && this.fl[cols - 1]! & WIDE) {
        this.text[cols - 1] = " ";
        this.fl[cols - 1] = 0;
      }
    } else {
      for (let i = old; i < cols; i++) this.text.push(" ");
      const fg = new Int32Array(cols).fill(DEFAULT);
      fg.set(this.fg);
      const bg = new Int32Array(cols).fill(DEFAULT);
      bg.set(this.bg);
      const fl = new Uint32Array(cols);
      fl.set(this.fl);
      this.fg = fg;
      this.bg = bg;
      this.fl = fl;
    }
  }

  clear(from: number, to: number, bg: number) {
    from = Math.max(0, from);
    to = Math.min(this.text.length, to);
    if (from >= to) return;
    // Erasing either half of a wide character erases the whole character.
    if (from > 0 && this.text[from] === "" && this.fl[from - 1]! & WIDE) from--;
    if (to < this.text.length && this.fl[to - 1]! & WIDE) to++;
    for (let i = from; i < to; i++) this.text[i] = " ";
    this.fg.fill(DEFAULT, from, to);
    this.bg.fill(bg, from, to);
    this.fl.fill(0, from, to);
    if (bg !== DEFAULT && to > this.hw) this.hw = to;
  }

  /** Upper bound of the cells holding anything (text or attributes). */
  usedWidth(): number {
    return Math.min(this.hw, this.text.length);
  }

  /** A copy holding only the first `n` cells (scrollback storage; re-expanded on view). */
  compactCopy(n: number): Line {
    const l = Object.create(Line.prototype) as Line;
    l.text = this.text.slice(0, n);
    l.fg = this.fg.slice(0, n);
    l.bg = this.bg.slice(0, n);
    l.fl = this.fl.slice(0, n);
    l.wrapped = this.wrapped;
    l.hw = n;
    return l;
  }

  /** Blanks the line for reuse; only the first `used` cells can hold anything. */
  recycle(used: number, bg: number) {
    const n = bg === DEFAULT ? used : this.text.length;
    for (let i = 0; i < n; i++) this.text[i] = " ";
    this.fg.fill(DEFAULT, 0, n);
    this.bg.fill(bg, 0, n);
    this.fl.fill(0, 0, n);
    this.wrapped = false;
    this.spoken = false;
    this.hw = bg === DEFAULT ? 0 : this.text.length;
  }

  copyCell(dst: number, src: Line, s: number) {
    if (dst >= this.hw) this.hw = dst + 1;
    this.text[dst] = src.text[s]!;
    this.fg[dst] = src.fg[s]!;
    this.bg[dst] = src.bg[s]!;
    this.fl[dst] = src.fl[s]!;
  }

  toString(trimRight = true): string {
    let s = "";
    for (let i = 0; i < this.text.length; i++) s += this.text[i];
    return trimRight ? s.replace(/\s+$/, "") : s;
  }
}

interface Cursor {
  x: number;
  y: number;
  fg: number;
  bg: number;
  fl: number;
  wrapPending: boolean;
  originMode: boolean;
  charsets: [boolean, boolean];
  gl: 0 | 1;
}

const DEC_GRAPHICS: Record<string, string> = {
  "`": "◆", a: "▒", b: "␉", c: "␌", d: "␍", e: "␊", f: "°", g: "±", h: "␤", i: "␋", j: "┘", k: "┐", l: "┌",
  m: "└", n: "┼", o: "⎺", p: "⎻", q: "─", r: "⎼", s: "⎽", t: "├", u: "┤", v: "┴", w: "┬", x: "│", y: "≤",
  z: "≥", "{": "π", "|": "≠", "}": "£", "~": "·",
};

export interface Modes {
  appCursor: boolean;
  appKeypad: boolean;
  autowrap: boolean;
  insert: boolean;
  newline: boolean;
  cursorVisible: boolean;
  cursorBlink: boolean;
  cursorShape: "block" | "underline" | "bar";
  bracketedPaste: boolean;
  focusEvents: boolean;
  mouse: 0 | 1000 | 1002 | 1003;
  mouseSgr: boolean;
  altScroll: boolean;
  synchronized: boolean;
  reverseVideo: boolean;
}

export interface TerminalHost {
  /** Bytes the terminal wants to send back to the application (reports, replies). */
  reply(data: string): void;
  title?(title: string): void;
  bell?(): void;
  clipboard?(text: string): void;
  cwd?(path: string): void;
  /** Colors for OSC 10/11/4 queries, as #rrggbb. */
  colors?(): { fg: string; bg: string; cursor: string; palette: string[] };
  /**
   * A line of output the program finished (line feed past it, or it scrolled into history),
   * trimmed; for assistive technology. Not called in the alternate screen or while `silent`.
   */
  onLine?(text: string): void;
}

const enum S {
  Ground,
  Esc,
  EscInter,
  Csi,
  CsiIgnore,
  Osc,
  OscEsc,
  Str, // DCS / SOS / PM / APC: swallowed until ST
  StrEsc,
}

export const MAX_SCROLLBACK = 10_000;

/**
 * Headless VT/xterm emulator: parser + screen model. Rendering lives in renderer.ts.
 * Coordinates are 0-based internally.
 */
export class Terminal {
  cols: number;
  rows: number;
  lines: Line[];
  scrollback: Line[] = [];
  private primary: Line[] | null = null; // saved primary screen while the alternate is active
  alt = false;
  cur: Cursor;
  private saved: Cursor | null = null;
  private savedPrimaryCursor: Cursor | null = null;
  top = 0;
  bottom: number;
  private tabs: boolean[] = [];
  modes!: Modes;
  title = "";
  links: string[] = [""];
  private linkId = 0;
  /** Rows changed since the renderer last painted. */
  dirty: Uint8Array;
  allDirty = true;
  /** Lines pushed to scrollback since last check (renderer uses it to keep the viewport stable). */
  scrolledOff = 0;
  /** Bumped when scrollback is trimmed, so absolute selections can be invalidated. */
  trimmed = 0;
  lastChar = "";
  /** Where lastChar was printed; a ZWJ join only applies when the cursor is still there. */
  private lastX = -1;
  private lastY = -1;

  private state = S.Ground;
  private params: number[] = [];
  private subs: (number[] | undefined)[] = [];
  private cur_param = -1;
  private cur_sub: number[] | null = null;
  private prefix = "";
  private inter = "";
  private osc = "";
  private decoder = new TextDecoder("utf-8");

  constructor(
    cols: number,
    rows: number,
    private host: TerminalHost,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.bottom = rows - 1;
    this.lines = Array.from({ length: rows }, () => new Line(cols));
    this.dirty = new Uint8Array(rows);
    this.cur = this.freshCursor();
    this.resetModes();
    this.resetTabs();
  }

  private freshCursor(): Cursor {
    return { x: 0, y: 0, fg: DEFAULT, bg: DEFAULT, fl: 0, wrapPending: false, originMode: false, charsets: [false, false], gl: 0 };
  }

  private resetModes() {
    this.modes = {
      appCursor: false,
      appKeypad: false,
      autowrap: true,
      insert: false,
      newline: false,
      cursorVisible: true,
      cursorBlink: true,
      cursorShape: "block",
      bracketedPaste: false,
      focusEvents: false,
      mouse: 0,
      mouseSgr: false,
      altScroll: true,
      synchronized: false,
      reverseVideo: false,
    };
  }

  private resetTabs() {
    this.tabs = [];
    for (let i = 0; i < this.cols; i++) this.tabs[i] = i % 8 === 0 && i > 0;
  }

  // ───────────────────────────── input ─────────────────────────────

  write(data: Uint8Array | string) {
    const s = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    const n = s.length;
    for (let i = 0; i < n; i++) {
      let c = s.charCodeAt(i);
      if (this.state === S.Ground && c >= 0x20 && c !== 0x7f && (c < 0x80 || c >= 0xa0)) {
        // Hot path: printable text.
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
          const lo = s.charCodeAt(i + 1);
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
            i++;
            this.print(c, String.fromCodePoint(c));
            continue;
          }
        }
        this.print(c, c < 0x80 ? ASCII[c]! : s[i]!);
        continue;
      }
      this.feed(c, s, i);
    }
  }

  private feed(c: number, s: string, i: number) {
    if (c === 0x18 || c === 0x1a) {
      this.state = S.Ground; // CAN/SUB abort any sequence, including OSC/DCS strings
      this.osc = "";
      return;
    }
    // C0 controls are executed in almost every state.
    if (c < 0x20 && this.state !== S.Osc && this.state !== S.Str) {
      if (c === 0x1b) {
        if (this.state === S.OscEsc || this.state === S.StrEsc) return;
        this.state = S.Esc;
        this.inter = "";
        return;
      }
      if (c === 0x18 || c === 0x1a) {
        this.state = S.Ground;
        return;
      }
      this.control(c);
      return;
    }
    switch (this.state) {
      case S.Ground:
        if (c === 0x7f) return;
        if (c >= 0x80 && c < 0xa0) return this.c1(c);
        return;
      case S.Esc:
        return this.escape(c, s[i]!);
      case S.EscInter:
        if (c >= 0x20 && c <= 0x2f) {
          this.inter += s[i];
          return;
        }
        this.escDispatch(s[i]!);
        this.state = S.Ground;
        return;
      case S.Csi:
        return this.csiChar(c, s[i]!);
      case S.CsiIgnore:
        if (c >= 0x40 && c <= 0x7e) this.state = S.Ground;
        return;
      case S.Osc:
        if (c === 0x07) return this.oscEnd();
        if (c === 0x1b) {
          this.state = S.OscEsc;
          return;
        }
        if (c === 0x9c) return this.oscEnd();
        if (c < 0x20) return; // other C0 controls are ignored inside a string (VT500)
        if (this.osc.length < 1 << 20) this.osc += s[i];
        return;
      case S.OscEsc:
        if (c === 0x5c) return this.oscEnd();
        // An unterminated OSC is abandoned; this ESC begins a new sequence (VT500 parser).
        this.osc = "";
        this.state = S.Esc;
        return this.escape(c, s[i]!);
      case S.Str:
        if (c === 0x1b) this.state = S.StrEsc;
        else if (c === 0x07 || c === 0x9c) this.state = S.Ground;
        return;
      case S.StrEsc:
        if (c === 0x5c) {
          this.state = S.Ground;
          return;
        }
        this.state = S.Esc;
        return this.escape(c, s[i]!);
    }
  }

  private escape(c: number, ch: string) {
    if (c === 0x5b) return this.csiStart(); // [
    if (c === 0x5d) {
      this.state = S.Osc; // ]
      this.osc = "";
      return;
    }
    if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) {
      this.state = S.Str; // DCS SOS PM APC
      return;
    }
    if (c >= 0x20 && c <= 0x2f) {
      this.inter = ch;
      this.state = S.EscInter;
      return;
    }
    this.state = S.Ground;
    this.escDispatch(ch);
  }

  private c1(c: number) {
    if (c === 0x9b) return this.csiStart();
    if (c === 0x9d) {
      this.state = S.Osc;
      this.osc = "";
      return;
    }
    if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) {
      this.state = S.Str;
      return;
    }
    if (c === 0x84) this.index();
    else if (c === 0x85) this.nextLine();
    else if (c === 0x88) this.tabs[this.cur.x] = true;
    else if (c === 0x8d) this.reverseIndex();
  }

  private csiStart() {
    this.state = S.Csi;
    this.params = [];
    this.subs = [];
    this.cur_param = -1;
    this.cur_sub = null;
    this.prefix = "";
    this.inter = "";
  }

  private csiChar(c: number, ch: string) {
    if (c >= 0x30 && c <= 0x39) {
      const d = c - 0x30;
      if (this.cur_sub) {
        const k = this.cur_sub.length - 1;
        this.cur_sub[k] = (this.cur_sub[k]! < 0 ? 0 : this.cur_sub[k]!) * 10 + d;
      } else this.cur_param = (this.cur_param < 0 ? 0 : this.cur_param) * 10 + d;
      if (this.cur_param > 0xffff) this.cur_param = 0xffff;
      return;
    }
    if (c === 0x3b) {
      this.pushParam();
      return;
    }
    if (c === 0x3a) {
      if (!this.cur_sub) this.cur_sub = [this.cur_param];
      this.cur_sub.push(-1);
      return;
    }
    if (c >= 0x3c && c <= 0x3f) {
      if (this.params.length || this.cur_param >= 0) this.state = S.CsiIgnore;
      else this.prefix += ch;
      return;
    }
    if (c >= 0x20 && c <= 0x2f) {
      this.inter += ch;
      return;
    }
    if (c >= 0x40 && c <= 0x7e) {
      this.pushParam();
      this.state = S.Ground;
      this.csiDispatch(ch);
      return;
    }
    this.state = S.CsiIgnore;
  }

  private pushParam() {
    if (this.cur_sub) {
      this.params.push(this.cur_sub[0]!);
      this.subs[this.params.length - 1] = this.cur_sub;
    } else this.params.push(this.cur_param);
    this.cur_param = -1;
    this.cur_sub = null;
  }

  private p(i: number, def: number): number {
    const v = this.params[i];
    return v === undefined || v < 0 || (v === 0 && def > 0) ? def : v;
  }

  // ───────────────────────────── screen ops ─────────────────────────────

  private markDirty(y: number) {
    if (y >= 0 && y < this.rows) this.dirty[y] = 1;
  }

  private markAll() {
    this.allDirty = true;
  }

  /** Rows of the scroll region changed (cheaper than markAll when viewing history). */
  private markRegion() {
    this.dirty.fill(1, this.top, this.bottom + 1);
  }

  private print(cp: number, ch: string) {
    const cur = this.cur;
    if (cp < 0x80 && this.cur.charsets[cur.gl]) ch = DEC_GRAPHICS[ch] ?? ch;
    let w = cp < 0x300 ? 1 : charWidth(cp);
    if (w === 0) {
      // Combining mark / ZWJ / variation selector: attach to the previous cell.
      const line = this.lines[cur.y]!;
      let x = cur.wrapPending ? cur.x : cur.x - 1;
      if (x >= 0 && line.text[x] === "" && x > 0) x--;
      if (x >= 0) {
        line.text[x] += ch;
        this.lastChar += ch; // so a following emoji can join a ZWJ sequence
        this.markDirty(cur.y);
      }
      return;
    }
    // Emoji ZWJ sequences: the glyph after a ZWJ joins the previous cluster (unless the
    // cursor was moved in between: then it is an ordinary print at the new position).
    if (this.lastChar.endsWith("‍") && cur.x === this.lastX && cur.y === this.lastY) {
      const line = this.lines[cur.y]!;
      let x = cur.wrapPending ? cur.x : cur.x - 1;
      if (x > 0 && line.text[x] === "") x--;
      if (x >= 0) {
        line.text[x] += ch;
        this.lastChar = ch;
        this.markDirty(cur.y);
        return;
      }
    }
    if (cur.wrapPending && this.modes.autowrap) {
      this.lines[cur.y]!.wrapped = true;
      cur.x = 0;
      this.index();
    }
    cur.wrapPending = false;
    if (w === 2 && cur.x === this.cols - 1) {
      if (this.modes.autowrap) {
        this.lines[cur.y]!.clear(cur.x, cur.x + 1, cur.bg);
        this.lines[cur.y]!.wrapped = true;
        cur.x = 0;
        this.index();
      } else w = 1;
    }
    const line = this.lines[cur.y]!;
    if (this.modes.insert) this.insertChars(w);
    this.fixWideOverlap(line, cur.x, w);
    if (cur.x + w > line.hw) line.hw = cur.x + w;
    line.text[cur.x] = ch;
    line.fg[cur.x] = cur.fg;
    line.bg[cur.x] = cur.bg;
    line.fl[cur.x] = cur.fl | (w === 2 ? WIDE : 0);
    if (w === 2) {
      line.text[cur.x + 1] = "";
      line.fg[cur.x + 1] = cur.fg;
      line.bg[cur.x + 1] = cur.bg;
      line.fl[cur.x + 1] = cur.fl;
    }
    this.dirty[cur.y] = 1;
    line.spoken = false;
    this.lastChar = ch;
    cur.x += w;
    if (cur.x >= this.cols) {
      cur.x = this.cols - 1;
      cur.wrapPending = this.modes.autowrap;
    }
    this.lastX = cur.x;
    this.lastY = cur.y;
  }

  /** Writing over half of a wide character must erase the other half. */
  private fixWideOverlap(line: Line, x: number, w: number) {
    if (line.text[x] === "" && x > 0 && line.fl[x - 1]! & WIDE) {
      line.text[x - 1] = " ";
      line.fl[x - 1] &= ~WIDE;
    }
    const end = x + w - 1;
    if (line.fl[end]! & WIDE && end + 1 < line.cols) {
      line.text[end + 1] = " ";
    }
  }

  private control(c: number) {
    const cur = this.cur;
    switch (c) {
      case 0x07:
        this.host.bell?.();
        break;
      case 0x08: // BS (xterm: pending wrap is dropped and the cursor still moves left)
        cur.wrapPending = false;
        if (cur.x > 0) cur.x--;
        break;
      case 0x09: // HT
        cur.x = this.nextTab(cur.x);
        cur.wrapPending = false;
        break;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.index();
        if (this.modes.newline) cur.x = 0;
        cur.wrapPending = false;
        break;
      case 0x0d:
        cur.x = 0;
        cur.wrapPending = false;
        break;
      case 0x0e:
        cur.gl = 1;
        break;
      case 0x0f:
        cur.gl = 0;
        break;
    }
  }

  private nextTab(x: number): number {
    for (let i = x + 1; i < this.cols; i++) if (this.tabs[i]) return i;
    return this.cols - 1;
  }

  private prevTab(x: number): number {
    for (let i = x - 1; i > 0; i--) if (this.tabs[i]) return i;
    return 0;
  }

  /** IND: move down, scrolling the region when at its bottom margin. */
  index() {
    if (this.host.onLine) this.announce(this.lines[this.cur.y]!);
    if (this.cur.y === this.bottom) this.scrollUp(1);
    else if (this.cur.y < this.rows - 1) this.cur.y++;
  }

  private reverseIndex() {
    if (this.cur.y === this.top) this.scrollDown(1);
    else if (this.cur.y > 0) this.cur.y--;
    this.cur.wrapPending = false;
  }

  private nextLine() {
    this.cur.x = 0;
    this.index();
    this.cur.wrapPending = false;
  }

  scrollUp(n: number) {
    const { top, bottom } = this;
    n = Math.min(n, bottom - top + 1);
    const toScrollback = !this.alt && top === 0;
    for (let i = 0; i < n; i++) {
      const old = this.lines.splice(top, 1)[0]!;
      // The departing line becomes the new blank bottom line: no per-line allocation,
      // and only the cells it actually used need clearing. History keeps a compact copy.
      const used = old.usedWidth();
      if (toScrollback) {
        if (this.host.onLine) this.announce(old);
        this.scrollback.push(old.compactCopy(used));
        this.scrolledOff++;
      }
      old.recycle(used, this.cur.bg);
      this.lines.splice(bottom, 0, old);
    }
    if (this.scrollback.length > MAX_SCROLLBACK + 1000) {
      this.scrollback.splice(0, this.scrollback.length - MAX_SCROLLBACK);
      this.trimmed++;
    }
    this.markRegion();
  }

  /** Reports a completed, non-empty line to the host once (screen reader log). */
  private announce(line: Line) {
    if (line.spoken || this.alt || line.hw === 0) return;
    line.spoken = true; // replayed history is consumed silently, and never reported later
    if (this.silent) return;
    const text = line.toString();
    if (text) this.host.onLine!(text);
  }

  scrollDown(n: number) {
    const { top, bottom } = this;
    n = Math.min(n, bottom - top + 1);
    for (let i = 0; i < n; i++) {
      this.lines.splice(bottom, 1);
      this.lines.splice(top, 0, new Line(this.cols, this.cur.bg));
    }
    this.markRegion();
  }

  private insertChars(n: number) {
    const line = this.lines[this.cur.y]!;
    const x = this.cur.x;
    n = Math.min(n, this.cols - x);
    this.splitWide(line, x);
    for (let i = this.cols - 1; i >= x + n; i--) line.copyCell(i, line, i - n);
    line.clear(x, x + n, this.cur.bg);
    // A wide character pushed onto the last column lost its second half.
    if (line.fl[this.cols - 1]! & WIDE) line.clear(this.cols - 1, this.cols, this.cur.bg);
    this.markDirty(this.cur.y);
  }

  private deleteChars(n: number) {
    const line = this.lines[this.cur.y]!;
    const x = this.cur.x;
    n = Math.min(n, this.cols - x);
    this.splitWide(line, x);
    for (let i = x; i < this.cols - n; i++) line.copyCell(i, line, i + n);
    line.clear(this.cols - n, this.cols, this.cur.bg);
    this.markDirty(this.cur.y);
  }

  /** Shifting cells from the second half of a wide character blanks the character (as xterm does). */
  private splitWide(line: Line, x: number) {
    if (x > 0 && line.text[x] === "" && line.fl[x - 1]! & WIDE) line.clear(x - 1, x, this.cur.bg);
  }

  private insertLines(n: number) {
    const y = this.cur.y;
    if (y < this.top || y > this.bottom) return;
    n = Math.min(n, this.bottom - y + 1);
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.bottom, 1);
      this.lines.splice(y, 0, new Line(this.cols, this.cur.bg));
    }
    this.cur.x = 0;
    this.markRegion();
  }

  private deleteLines(n: number) {
    const y = this.cur.y;
    if (y < this.top || y > this.bottom) return;
    n = Math.min(n, this.bottom - y + 1);
    for (let i = 0; i < n; i++) {
      this.lines.splice(y, 1);
      this.lines.splice(this.bottom, 0, new Line(this.cols, this.cur.bg));
    }
    this.cur.x = 0;
    this.markRegion();
  }

  private eraseInDisplay(mode: number) {
    this.cur.wrapPending = false;
    const { x, y, bg } = { ...this.cur };
    if (mode === 0) {
      this.lines[y]!.clear(x, this.cols, bg);
      this.lines[y]!.wrapped = false;
      for (let i = y + 1; i < this.rows; i++) this.resetLine(i);
    } else if (mode === 1) {
      for (let i = 0; i < y; i++) this.resetLine(i);
      this.lines[y]!.clear(0, x + 1, bg);
    } else if (mode === 2) {
      for (let i = 0; i < this.rows; i++) this.resetLine(i);
    } else if (mode === 3) {
      this.scrollback = [];
      this.trimmed++;
    }
    this.markAll();
  }

  private resetLine(y: number) {
    this.lines[y] = new Line(this.cols, this.cur.bg);
  }

  private eraseInLine(mode: number) {
    this.cur.wrapPending = false;
    const { x, y, bg } = this.cur;
    const line = this.lines[y]!;
    if (mode === 0) {
      line.clear(x, this.cols, bg);
      line.wrapped = false;
    } else if (mode === 1) line.clear(0, x + 1, bg);
    else if (mode === 2) {
      line.clear(0, this.cols, bg);
      line.wrapped = false;
    }
    this.markDirty(y);
  }

  private moveTo(x: number, y: number) {
    const cur = this.cur;
    const minY = cur.originMode ? this.top : 0;
    const maxY = cur.originMode ? this.bottom : this.rows - 1;
    cur.x = Math.max(0, Math.min(this.cols - 1, x));
    cur.y = Math.max(minY, Math.min(maxY, y + (cur.originMode ? this.top : 0)));
    cur.wrapPending = false;
  }

  private setScrollRegion(top: number, bottom: number) {
    if (bottom <= top || bottom >= this.rows) {
      if (bottom >= this.rows) bottom = this.rows - 1;
      if (bottom <= top) return;
    }
    this.top = top;
    this.bottom = bottom;
    this.moveTo(0, 0);
  }

  private saveCursor() {
    this.saved = { ...this.cur, charsets: [...this.cur.charsets] as [boolean, boolean] };
  }

  private restoreCursor() {
    if (!this.saved) {
      this.cur.x = 0;
      this.cur.y = 0;
      this.cur.wrapPending = false;
      return;
    }
    this.cur = { ...this.saved, charsets: [...this.saved.charsets] as [boolean, boolean] };
    this.cur.x = Math.min(this.cur.x, this.cols - 1);
    this.cur.y = Math.min(this.cur.y, this.rows - 1);
  }

  private enterAlt(clear: boolean, saveCursor: boolean) {
    if (this.alt) return;
    if (saveCursor) this.savedPrimaryCursor = { ...this.cur, charsets: [...this.cur.charsets] as [boolean, boolean] };
    this.primary = this.lines;
    this.lines = Array.from({ length: this.rows }, () => new Line(this.cols));
    this.alt = true;
    if (clear) this.lines.forEach((_, i) => this.resetLine(i));
    this.markAll();
  }

  private exitAlt(restoreCursor: boolean) {
    if (!this.alt || !this.primary) return;
    this.lines = this.primary;
    this.primary = null;
    this.alt = false;
    if (restoreCursor && this.savedPrimaryCursor) {
      this.cur = { ...this.savedPrimaryCursor, charsets: [...this.savedPrimaryCursor.charsets] as [boolean, boolean] };
      this.cur.x = Math.min(this.cur.x, this.cols - 1);
      this.cur.y = Math.min(this.cur.y, this.rows - 1);
    }
    this.markAll();
  }

  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    cols = Math.max(2, cols);
    rows = Math.max(1, rows);
    const resizeSet = (set: Line[], isPrimary: boolean, cursor: Cursor | null): Line[] => {
      for (const l of set) l.resize(cols);
      if (rows < set.length) {
        // Keep the cursor visible: push lines above it into scrollback first.
        let excess = set.length - rows;
        const cy = cursor ? cursor.y : 0;
        const fromTop = Math.min(excess, Math.max(0, cy - rows + 1));
        const removed = set.splice(0, fromTop);
        if (isPrimary) {
          this.scrollback.push(...removed);
          this.scrolledOff += removed.length;
        }
        if (cursor) cursor.y -= fromTop;
        if (isPrimary && this.saved && !this.alt) this.saved.y = Math.max(0, this.saved.y - fromTop);
        excess -= fromTop;
        set.splice(set.length - excess, excess);
      } else if (rows > set.length) {
        let need = rows - set.length;
        if (isPrimary && cursor) {
          // Pull history back down, like xterm, when the screen grows.
          const pull = Math.min(need, this.scrollback.length);
          if (pull > 0) {
            const pulled = this.scrollback.splice(this.scrollback.length - pull, pull);
            for (const l of pulled) l.resize(cols);
            set.unshift(...pulled);
            cursor.y += pull;
            if (this.saved && !this.alt) this.saved.y += pull;
            need -= pull;
            this.trimmed++;
          }
        }
        for (let i = 0; i < need; i++) set.push(new Line(cols));
      }
      return set;
    };
    if (this.alt) {
      this.lines = resizeSet(this.lines, false, this.cur);
      if (this.primary) this.primary = resizeSet(this.primary, true, this.savedPrimaryCursor ?? { ...this.cur, y: this.rows - 1 });
    } else {
      this.lines = resizeSet(this.lines, true, this.cur);
    }
    // Scrollback lines are re-widened lazily when viewed (see viewLine/absLine).
    this.cols = cols;
    this.rows = rows;
    this.top = 0;
    this.bottom = rows - 1;
    this.cur.x = Math.min(this.cur.x, cols - 1);
    this.cur.y = Math.max(0, Math.min(this.cur.y, rows - 1));
    this.cur.wrapPending = false;
    if (this.saved) {
      this.saved.x = Math.min(this.saved.x, cols - 1);
      this.saved.y = Math.min(this.saved.y, rows - 1);
    }
    this.dirty = new Uint8Array(rows);
    const oldTabs = this.tabs;
    this.resetTabs();
    for (let i = 0; i < Math.min(oldTabs.length, cols); i++) this.tabs[i] = oldTabs[i]!;
    this.markAll();
  }

  reset() {
    this.alt = false;
    this.primary = null;
    this.savedPrimaryCursor = null;
    this.decoder = new TextDecoder("utf-8");
    this.links = [""];
    this.linkId = 0;
    this.scrolledOff = 0;
    this.lastChar = "";
    this.osc = "";
    this.lines = Array.from({ length: this.rows }, () => new Line(this.cols));
    this.scrollback = [];
    this.trimmed++;
    this.cur = this.freshCursor();
    this.saved = null;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.resetModes();
    this.resetTabs();
    this.state = S.Ground;
    this.markAll();
  }

  // ───────────────────────────── dispatch ─────────────────────────────

  private escDispatch(ch: string) {
    const inter = this.inter;
    this.inter = "";
    if (inter === "(" || inter === ")") {
      this.cur.charsets[inter === "(" ? 0 : 1] = ch === "0";
      return;
    }
    if (inter === "#") {
      if (ch === "8") {
        // DECALN: fill screen with E
        for (const l of this.lines) {
          for (let i = 0; i < this.cols; i++) l.text[i] = "E";
          l.hw = this.cols;
        }
        this.markAll();
      }
      return;
    }
    if (inter) return;
    switch (ch) {
      case "7":
        return this.saveCursor();
      case "8":
        return this.restoreCursor();
      case "D":
        return this.index();
      case "E":
        return this.nextLine();
      case "H":
        this.tabs[this.cur.x] = true;
        return;
      case "M":
        return this.reverseIndex();
      case "c":
        return this.reset();
      case "=":
        this.modes.appKeypad = true;
        return;
      case ">":
        this.modes.appKeypad = false;
        return;
    }
  }

  private csiDispatch(f: string) {
    const cur = this.cur;
    const pre = this.prefix;
    const inter = this.inter;
    if (inter) return this.csiInter(f, pre, inter);
    if (pre === "?") return this.csiPrivate(f);
    if (pre === ">") {
      if (f === "c") this.respond("\x1b[>0;10;1c"); // DA2
      else if (f === "q") this.respond("\x1bP>|codeviewer 1.0\x1b\\"); // XTVERSION
      return;
    }
    if (pre) return;
    switch (f) {
      case "@":
        return this.insertChars(this.p(0, 1));
      case "A":
        cur.y = Math.max(cur.y >= this.top ? this.top : 0, cur.y - this.p(0, 1));
        cur.wrapPending = false;
        return;
      case "B":
        cur.y = Math.min(cur.y <= this.bottom ? this.bottom : this.rows - 1, cur.y + this.p(0, 1));
        cur.wrapPending = false;
        return;
      case "C":
      case "a":
        cur.x = Math.min(this.cols - 1, cur.x + this.p(0, 1));
        cur.wrapPending = false;
        return;
      case "D":
        cur.x = Math.max(0, cur.x - this.p(0, 1));
        cur.wrapPending = false;
        return;
      case "E":
        cur.x = 0;
        cur.y = Math.min(cur.y <= this.bottom ? this.bottom : this.rows - 1, cur.y + this.p(0, 1));
        cur.wrapPending = false;
        return;
      case "F":
        cur.x = 0;
        cur.y = Math.max(cur.y >= this.top ? this.top : 0, cur.y - this.p(0, 1));
        cur.wrapPending = false;
        return;
      case "G":
      case "`":
        cur.x = Math.min(this.cols - 1, this.p(0, 1) - 1);
        cur.wrapPending = false;
        return;
      case "H":
      case "f":
        return this.moveTo(this.p(1, 1) - 1, this.p(0, 1) - 1);
      case "I":
        for (let i = this.p(0, 1); i > 0; i--) cur.x = this.nextTab(cur.x);
        cur.wrapPending = false;
        return;
      case "Z":
        for (let i = this.p(0, 1); i > 0; i--) cur.x = this.prevTab(cur.x);
        cur.wrapPending = false;
        return;
      case "J":
        return this.eraseInDisplay(this.p(0, 0));
      case "K":
        return this.eraseInLine(this.p(0, 0));
      case "L":
        return this.insertLines(this.p(0, 1));
      case "M":
        return this.deleteLines(this.p(0, 1));
      case "P":
        return this.deleteChars(this.p(0, 1));
      case "S":
        return this.scrollUp(this.p(0, 1));
      case "T":
        if (this.params.length <= 1) this.scrollDown(this.p(0, 1));
        return;
      case "X": {
        const n = Math.min(this.p(0, 1), this.cols - cur.x);
        this.lines[cur.y]!.clear(cur.x, cur.x + n, cur.bg);
        this.markDirty(cur.y);
        cur.wrapPending = false;
        return;
      }
      case "b": {
        // REP: repeat the preceding graphic character.
        const ch = this.lastChar;
        if (!ch) return;
        const cp = ch.codePointAt(0)!;
        for (let i = Math.min(this.p(0, 1), 65535); i > 0; i--) this.print(cp, ch);
        return;
      }
      case "c":
        if (this.p(0, 0) === 0) this.respond("\x1b[?62;22c"); // DA1: VT220 + ANSI color
        return;
      case "d":
        return this.moveTo(cur.x, this.p(0, 1) - 1);
      case "e":
        return this.moveTo(cur.x, cur.y - (cur.originMode ? this.top : 0) + this.p(0, 1));
      case "g": {
        const m = this.p(0, 0);
        if (m === 0) this.tabs[cur.x] = false;
        else if (m === 3) this.tabs = this.tabs.map(() => false);
        return;
      }
      case "h":
      case "l": {
        const on = f === "h";
        for (const m of this.params) {
          if (m === 4) this.modes.insert = on;
          else if (m === 20) this.modes.newline = on;
        }
        return;
      }
      case "m":
        return this.sgr();
      case "n": {
        const m = this.p(0, 0);
        if (m === 5) this.respond("\x1b[0n");
        else if (m === 6) {
          const y = cur.y - (cur.originMode ? this.top : 0);
          this.respond(`\x1b[${y + 1};${cur.x + 1}R`);
        }
        return;
      }
      case "r":
        return this.setScrollRegion(this.p(0, 1) - 1, this.p(1, this.rows) - 1);
      case "s":
        return this.saveCursor();
      case "u":
        return this.restoreCursor();
      case "t": {
        const m = this.p(0, 0);
        if (m === 18) this.respond(`\x1b[8;${this.rows};${this.cols}t`);
        else if (m === 14 && this.cellPx) this.respond(`\x1b[4;${this.rows * this.cellPx.h};${this.cols * this.cellPx.w}t`);
        else if (m === 16 && this.cellPx) this.respond(`\x1b[6;${this.cellPx.h};${this.cellPx.w}t`);
        return;
      }
    }
  }

  /** While true (e.g. replaying history after a reconnect), queries are not answered. */
  silent = false;

  private respond(data: string) {
    if (!this.silent) this.host.reply(data);
  }

  /** Set by the renderer so pixel-size queries can be answered. */
  cellPx: { w: number; h: number } | null = null;

  private csiInter(f: string, pre: string, inter: string) {
    if (inter === " " && f === "q") {
      const n = this.p(0, 1);
      this.modes.cursorShape = n <= 2 ? "block" : n <= 4 ? "underline" : "bar";
      this.modes.cursorBlink = n === 0 || n % 2 === 1;
      return;
    }
    if (inter === "!" && f === "p") {
      // DECSTR soft reset
      const keep = { ...this.modes };
      this.resetModes();
      // xterm's soft reset leaves mouse, paste, focus, scroll and screen modes alone.
      for (const k of ["mouse", "mouseSgr", "bracketedPaste", "focusEvents", "altScroll", "synchronized", "reverseVideo"] as const) {
        (this.modes as unknown as Record<string, unknown>)[k] = keep[k];
      }
      this.cur.fg = DEFAULT;
      this.cur.bg = DEFAULT;
      this.cur.fl = 0;
      this.cur.originMode = false;
      this.cur.charsets = [false, false];
      this.cur.gl = 0;
      this.saved = null;
      this.top = 0;
      this.bottom = this.rows - 1;
      return;
    }
    if (inter === "$" && f === "p") {
      // DECRQM: report mode state. 1 = set, 2 = reset, 0 = unknown.
      const m = this.p(0, 0);
      const v = pre === "?" ? this.privateModeState(m) : m === 4 ? (this.modes.insert ? 1 : 2) : 0;
      this.respond(`\x1b[${pre}${m};${v}$y`);
    }
  }

  private privateModeState(m: number): number {
    const md = this.modes;
    const b = (x: boolean) => (x ? 1 : 2);
    switch (m) {
      case 1: return b(md.appCursor);
      case 6: return b(this.cur.originMode);
      case 7: return b(md.autowrap);
      case 12: return b(md.cursorBlink);
      case 25: return b(md.cursorVisible);
      case 1000: case 1002: case 1003: return b(md.mouse === m);
      case 1004: return b(md.focusEvents);
      case 1006: return b(md.mouseSgr);
      case 1007: return b(md.altScroll);
      case 47: case 1047: case 1049: return b(this.alt);
      case 2004: return b(md.bracketedPaste);
      case 2026: return b(md.synchronized);
      default: return 0;
    }
  }

  private csiPrivate(f: string) {
    if (f === "h" || f === "l") {
      const on = f === "h";
      for (const m of this.params) this.setPrivateMode(m, on);
      return;
    }
    if (f === "J") return this.eraseInDisplay(this.p(0, 0));
    if (f === "K") return this.eraseInLine(this.p(0, 0));
    if (f === "n" && this.p(0, 0) === 6) {
      const y = this.cur.y - (this.cur.originMode ? this.top : 0);
      this.respond(`\x1b[?${y + 1};${this.cur.x + 1}R`);
    }
    // "?u" (kitty keyboard query) is deliberately unanswered: clients fall back to legacy keys.
  }

  private setPrivateMode(m: number, on: boolean) {
    const md = this.modes;
    switch (m) {
      case 1:
        md.appCursor = on;
        break;
      case 5:
        md.reverseVideo = on;
        this.markAll();
        break;
      case 6:
        this.cur.originMode = on;
        this.moveTo(0, 0);
        break;
      case 7:
        md.autowrap = on;
        break;
      case 12:
        md.cursorBlink = on;
        break;
      case 25:
        md.cursorVisible = on;
        this.markDirty(this.cur.y);
        break;
      case 66:
        md.appKeypad = on;
        break;
      case 9:
      case 1000:
      case 1002:
      case 1003:
        md.mouse = on ? (m === 9 ? 1000 : m) : 0;
        break;
      case 1004:
        md.focusEvents = on;
        break;
      case 1006:
        md.mouseSgr = on;
        break;
      case 1007:
        md.altScroll = on;
        break;
      case 47:
      case 1047:
        if (on) this.enterAlt(m === 1047, false);
        else this.exitAlt(false);
        break;
      case 1048:
        if (on) this.saveCursor();
        else this.restoreCursor();
        break;
      case 1049:
        if (on) this.enterAlt(true, true);
        else this.exitAlt(true);
        break;
      case 2004:
        md.bracketedPaste = on;
        break;
      case 2026:
        md.synchronized = on;
        if (!on) this.markAll();
        break;
    }
  }

  private sgr() {
    const ps = this.params;
    const cur = this.cur;
    if (ps.length === 0) ps.push(0);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]! < 0 ? 0 : ps[i]!;
      const sub = this.subs[i];
      if (p === 0) {
        cur.fg = DEFAULT;
        cur.bg = DEFAULT;
        cur.fl = (cur.fl & ~STYLE_MASK) & 0xffff0000;
      } else if (p === 1) cur.fl |= BOLD;
      else if (p === 2) cur.fl |= DIM;
      else if (p === 3) cur.fl |= ITALIC;
      else if (p === 4) {
        if (sub && sub[1] === 0) cur.fl &= ~UNDERLINE;
        else cur.fl |= UNDERLINE;
      } else if (p === 5 || p === 6) cur.fl |= BLINK;
      else if (p === 7) cur.fl |= INVERSE;
      else if (p === 8) cur.fl |= HIDDEN;
      else if (p === 9) cur.fl |= STRIKE;
      else if (p === 21) cur.fl |= UNDERLINE;
      else if (p === 22) cur.fl &= ~(BOLD | DIM);
      else if (p === 23) cur.fl &= ~ITALIC;
      else if (p === 24) cur.fl &= ~UNDERLINE;
      else if (p === 25) cur.fl &= ~BLINK;
      else if (p === 27) cur.fl &= ~INVERSE;
      else if (p === 28) cur.fl &= ~HIDDEN;
      else if (p === 29) cur.fl &= ~STRIKE;
      else if (p >= 30 && p <= 37) cur.fg = p - 30;
      else if (p === 39) cur.fg = DEFAULT;
      else if (p >= 40 && p <= 47) cur.bg = p - 40;
      else if (p === 49) cur.bg = DEFAULT;
      else if (p === 53) cur.fl |= OVERLINE;
      else if (p === 55) cur.fl &= ~OVERLINE;
      else if (p >= 90 && p <= 97) cur.fg = p - 90 + 8;
      else if (p >= 100 && p <= 107) cur.bg = p - 100 + 8;
      else if (p === 38 || p === 48 || p === 58) {
        let color: number | null = null;
        if (sub) {
          // Colon form: 38:5:n or 38:2:[cs]:r:g:b
          if (sub[1] === 5) color = clamp255(sub[2]);
          else if (sub[1] === 2) {
            const rgb = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
            color = RGB_FLAG | (clamp255(rgb[0]) << 16) | (clamp255(rgb[1]) << 8) | clamp255(rgb[2]);
          }
        } else if (ps[i + 1] === 5) {
          color = clamp255(ps[i + 2]);
          i += 2;
        } else if (ps[i + 1] === 2) {
          color = RGB_FLAG | (clamp255(ps[i + 2]) << 16) | (clamp255(ps[i + 3]) << 8) | clamp255(ps[i + 4]);
          i += 4;
        }
        if (color !== null) {
          if (p === 38) cur.fg = color;
          else if (p === 48) cur.bg = color;
        }
      }
    }
  }

  private oscEnd() {
    this.state = S.Ground;
    const s = this.osc;
    this.osc = "";
    const semi = s.indexOf(";");
    const code = semi < 0 ? s : s.slice(0, semi);
    const arg = semi < 0 ? "" : s.slice(semi + 1);
    switch (code) {
      case "0":
      case "2":
        this.title = arg;
        this.host.title?.(arg);
        return;
      case "7":
        try {
          this.host.cwd?.(decodeURIComponent(new URL(arg).pathname));
        } catch {}
        return;
      case "8": {
        // OSC 8 ; params ; URI
        const uri = arg.slice(arg.indexOf(";") + 1);
        if (!uri) {
          this.cur.fl &= 0xffff;
          return;
        }
        let id = this.links.lastIndexOf(uri);
        if (id <= 0) {
          this.linkId = (this.linkId % 0xfffe) + 1;
          id = this.linkId;
          this.links[id] = uri;
        }
        this.cur.fl = (this.cur.fl & 0xffff) | (id << 16);
        return;
      }
      case "10":
      case "11":
      case "12": {
        if (arg !== "?") return;
        const c = this.host.colors?.();
        if (!c) return;
        const hex = code === "10" ? c.fg : code === "11" ? c.bg : c.cursor;
        this.respond(`\x1b]${code};${xrgb(hex)}\x1b\\`);
        return;
      }
      case "4": {
        const parts = arg.split(";");
        const c = this.host.colors?.();
        for (let i = 0; i + 1 < parts.length; i += 2) {
          if (parts[i + 1] === "?" && c) {
            const n = Number(parts[i]);
            const hex = c.palette[n];
            if (hex) this.respond(`\x1b]4;${n};${xrgb(hex)}\x1b\\`);
          }
        }
        return;
      }
      case "52": {
        // Clipboard write only; queries are refused for privacy.
        const data = arg.slice(arg.indexOf(";") + 1);
        if (data === "?" || this.silent) return; // replayed history must not touch the clipboard
        try {
          const bin = atob(data);
          const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
          this.host.clipboard?.(new TextDecoder().decode(bytes));
        } catch {}
        return;
      }
    }
  }

  // ───────────────────────────── queries for renderer ─────────────────────────────

  /** Line at viewport row y when scrolled `offset` lines up into history. */
  viewLine(y: number, offset: number): Line | undefined {
    return this.absLine(this.scrollback.length - offset + y);
  }

  /** Absolute line index (scrollback + screen). Compact history lines are widened on access. */
  absLine(i: number): Line | undefined {
    if (i >= this.scrollback.length) return this.lines[i - this.scrollback.length];
    const l = this.scrollback[i];
    if (l && l.cols < this.cols) l.resize(this.cols);
    return l;
  }

  get totalLines() {
    return this.scrollback.length + this.rows;
  }
}

const ASCII: string[] = Array.from({ length: 128 }, (_, i) => String.fromCharCode(i));

function clamp255(v: number | undefined): number {
  return v === undefined || v < 0 ? 0 : v > 255 ? 255 : v;
}

function xrgb(hex: string): string {
  const h = hex.replace("#", "");
  const c = (i: number) => h.slice(i, i + 2).repeat(2);
  return `rgb:${c(0)}/${c(2)}/${c(4)}`;
}
