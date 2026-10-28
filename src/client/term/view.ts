import { Terminal, WIDE } from "./terminal.ts";
import { Renderer, type Theme, type Point } from "./renderer.ts";

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

// Keyboard layout (where the browser exposes it) so ⌥-shortcuts follow AZERTY, Dvorak, …
let layoutMap: Map<string, string> | null = null;
(navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard
  ?.getLayoutMap?.()
  .then((m) => (layoutMap = m))
  .catch(() => {});

export interface TerminalViewOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  theme: Theme;
  /** Bytes typed by the user or replies from the emulator, to the PTY. */
  send(data: string): void;
  resize(cols: number, rows: number): void;
  onTitle?(title: string): void;
  onOpenPath?(path: string, line: number): void;
  /** External links are opened by the host (outside the app window). */
  onOpenUrl?(url: string): void;
}

// Paths like src/a.ts, ./x/y.go:12, /abs/file.py:3:7, and URLs.
// The last path segment may contain dots (foo.test.ts, index.d.ts, jquery.min.js).
const LINK_RE = /(https?:\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]}])|((?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.\w+(?::\d+(?::\d+)?)?)/g;

const KEYS: Record<string, [string, string?]> = {
  // key: [normal, application-cursor-mode]
  ArrowUp: ["\x1b[A", "\x1bOA"],
  ArrowDown: ["\x1b[B", "\x1bOB"],
  ArrowRight: ["\x1b[C", "\x1bOC"],
  ArrowLeft: ["\x1b[D", "\x1bOD"],
  Home: ["\x1b[H", "\x1bOH"],
  End: ["\x1b[F", "\x1bOF"],
  Insert: ["\x1b[2~"],
  Delete: ["\x1b[3~"],
  PageUp: ["\x1b[5~"],
  PageDown: ["\x1b[6~"],
  F1: ["\x1bOP"],
  F2: ["\x1bOQ"],
  F3: ["\x1bOR"],
  F4: ["\x1bOS"],
  F5: ["\x1b[15~"],
  F6: ["\x1b[17~"],
  F7: ["\x1b[18~"],
  F8: ["\x1b[19~"],
  F9: ["\x1b[20~"],
  F10: ["\x1b[21~"],
  F11: ["\x1b[23~"],
  F12: ["\x1b[24~"],
};

/**
 * A complete terminal widget: emulator + canvas renderer + keyboard/mouse/clipboard.
 */
export class TerminalView {
  readonly el: HTMLElement;
  readonly term: Terminal;
  readonly renderer: Renderer;
  private input: HTMLTextAreaElement;
  private scrollbar: HTMLElement;
  private thumb: HTMLElement;
  private ro: ResizeObserver;
  private blinkTimer = 0;
  private selecting: { anchor: Point; mode: "char" | "word" | "line" } | null = null;
  private lastClick = { t: 0, n: 0, x: -1, y: -1 };
  private leftAltDown = false;
  private composing = false;
  private disposed = false;

  constructor(private opts: TerminalViewOptions) {
    this.el = document.createElement("div");
    this.el.className = "term";
    this.term = new Terminal(80, 24, {
      reply: (d) => opts.send(d),
      title: (t) => opts.onTitle?.(t),
      // OSC 52: allowed (editors and agents use it), but never silently.
      clipboard: (t) =>
        void navigator.clipboard
          ?.writeText(t)
          .then(() => window.dispatchEvent(new CustomEvent("cv-toast", { detail: `A terminal program copied ${t.length.toLocaleString()} characters to your clipboard` })))
          .catch(() => {}),
      colors: () => ({ fg: opts.theme.fg, bg: opts.theme.bg, cursor: opts.theme.cursor, palette: this.renderer.palette }),
      bell: () => {
        this.el.classList.remove("bell");
        void this.el.offsetWidth;
        this.el.classList.add("bell");
      },
    });
    this.renderer = new Renderer(this.term);
    this.renderer.setTheme(opts.theme);
    this.renderer.onFrame = () => this.updateScrollbar();

    this.input = document.createElement("textarea");
    this.input.className = "term-input";
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocorrect", "off");
    this.input.setAttribute("spellcheck", "false");
    this.input.setAttribute("aria-label", "Terminal input");
    this.input.tabIndex = 0;

    this.scrollbar = document.createElement("div");
    this.scrollbar.className = "term-scrollbar";
    this.thumb = document.createElement("div");
    this.thumb.className = "term-thumb";
    this.scrollbar.append(this.thumb);

    this.el.append(this.renderer.canvas, this.input, this.scrollbar);
    this.bindKeyboard();
    this.bindMouse();
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this.el);
    this.renderer.setFont(opts.fontFamily, opts.fontSize, opts.lineHeight);
    // Browser zoom / moving between displays changes devicePixelRatio: re-measure the font.
    let dpr = window.devicePixelRatio;
    window.addEventListener("resize", () => {
      if (window.devicePixelRatio !== dpr) {
        dpr = window.devicePixelRatio;
        this.refreshFont();
      }
    });
  }

  write(data: Uint8Array | string, silent = false) {
    this.term.silent = silent;
    this.term.write(data);
    this.term.silent = false;
    this.renderer.schedule();
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  setTheme(t: Theme) {
    this.opts.theme = t;
    this.renderer.setTheme(t);
  }

  setFont(family: string, size: number, lineHeight: number) {
    Object.assign(this.opts, { fontFamily: family, fontSize: size, lineHeight });
    this.refreshFont();
  }

  private refreshFont() {
    if (this.disposed) return;
    this.renderer.setFont(this.opts.fontFamily, this.opts.fontSize, this.opts.lineHeight);
    this.fit(true);
  }

  fit(force = false) {
    const r = this.el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const { cols, rows } = this.renderer.measure(r.width - 14, r.height - 4);
    if (force || cols !== this.term.cols || rows !== this.term.rows) {
      this.term.resize(cols, rows);
      this.renderer.resizeCanvas();
      this.opts.resize(cols, rows);
    }
  }

  clear() {
    this.term.write("\x1b[H\x1b[2J\x1b[3J");
    this.renderer.viewOffset = 0;
    this.renderer.invalidate();
  }

  reset() {
    this.term.reset();
    this.renderer.viewOffset = 0;
    this.renderer.selection = null;
    this.renderer.invalidate();
  }

  dispose() {
    this.disposed = true;
    this.ro.disconnect();
    clearInterval(this.blinkTimer);
    this.el.remove();
  }

  // ───────────────────────────── keyboard ─────────────────────────────

  private typed(data: string) {
    if (this.renderer.viewOffset !== 0) {
      this.renderer.viewOffset = 0;
      this.renderer.invalidate();
    }
    this.clearSelection();
    this.restartBlink();
    this.opts.send(data);
  }

  private bindKeyboard() {
    const inp = this.input;
    inp.addEventListener("focus", () => {
      this.renderer.focused = true;
      this.restartBlink();
      if (this.term.modes.focusEvents) this.opts.send("\x1b[I");
      this.renderer.touchAll();
      this.el.classList.add("focused");
    });
    inp.addEventListener("blur", () => {
      this.renderer.focused = false;
      clearInterval(this.blinkTimer);
      if (this.term.modes.focusEvents) this.opts.send("\x1b[O");
      this.renderer.touchAll();
      this.el.classList.remove("focused");
    });
    inp.addEventListener("compositionstart", () => (this.composing = true));
    inp.addEventListener("compositionend", (e) => {
      this.composing = false;
      if (e.data) this.typed(e.data);
      inp.value = "";
    });
    inp.addEventListener("input", (e) => {
      const ie = e as InputEvent;
      if (this.composing || ie.isComposing) return;
      if (ie.inputType === "insertText" && ie.data) this.typed(ie.data);
      inp.value = "";
    });
    inp.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain");
      if (text) this.paste(text);
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "AltLeft") this.leftAltDown = false;
    });
    inp.addEventListener("keydown", (e) => this.onKey(e));
  }

  paste(text: string) {
    text = text.replace(/\r?\n/g, "\r");
    // Inside a bracketed paste nothing may look like a control sequence: removing just the
    // end marker can be defeated by nesting it ("\x1b[20\x1b[201~1~"), so drop every ESC/C1.
    if (this.term.modes.bracketedPaste) text = `\x1b[200~${text.replace(/[\x1b\x80-\x9f]/g, "")}\x1b[201~`;
    this.typed(text);
  }

  private onKey(e: KeyboardEvent) {
    if (e.code === "AltLeft") this.leftAltDown = true;
    if (this.composing || e.isComposing || e.keyCode === 229) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey && e.shiftKey;

    // Clipboard & view shortcuts (⌘ on macOS, Ctrl+Shift elsewhere).
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === "c") {
        const sel = this.selectionText();
        if (sel) {
          e.preventDefault();
          void navigator.clipboard.writeText(sel);
          return;
        }
        if (IS_MAC) return;
      }
      if (k === "v") return; // native paste event follows
      if (k === "k") {
        e.preventDefault();
        this.clear();
        this.opts.send("\x0c");
        return;
      }
      if (k === "a" && IS_MAC) {
        e.preventDefault();
        this.selectAll();
        return;
      }
    }
    if (e.metaKey) return; // leave ⌘-shortcuts to the app / browser

    if (e.shiftKey && (e.key === "PageUp" || e.key === "PageDown") && !this.term.alt) {
      e.preventDefault();
      this.scrollBy((e.key === "PageUp" ? 1 : -1) * (this.term.rows - 1));
      return;
    }

    const seq = this.keySequence(e);
    if (seq !== null) {
      e.preventDefault();
      this.typed(seq);
    }
  }

  private keySequence(e: KeyboardEvent): string | null {
    const { key } = e;
    // Left ⌥ acts as Meta on macOS; right ⌥ composes characters (like iTerm2).
    const meta = e.altKey && (!IS_MAC || this.leftAltDown);
    const m = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);

    if (key === "Enter") return e.shiftKey || meta ? "\x1b\r" : "\r";
    if (key === "Backspace") return e.ctrlKey ? "\x08" : meta ? "\x1b\x7f" : "\x7f";
    if (key === "Tab") return e.shiftKey ? "\x1b[Z" : "\t";
    if (key === "Escape") return "\x1b";

    const special = KEYS[key];
    if (special) {
      if (m > 1) {
        const s = special[0];
        if (s.endsWith("~")) return s.slice(0, -1) + `;${m}~`;
        return `\x1b[1;${m}${s[s.length - 1]}`;
      }
      return (this.term.modes.appCursor && special[1]) || special[0];
    }

    if (e.ctrlKey && !meta) {
      if (key.length === 1) {
        const c = key.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
        if (key === " " || key === "@" || key === "2") return "\x00";
        if (key === "[" || key === "3") return "\x1b";
        if (key === "\\" || key === "4") return "\x1c";
        if (key === "]" || key === "5") return "\x1d";
        if (key === "^" || key === "6") return "\x1e";
        if (key === "_" || key === "-" || key === "/" || key === "7") return "\x1f";
        if (key === "8" || key === "?") return "\x7f";
      }
      return null;
    }

    if (meta) {
      // On macOS ⌥ composes ("∫" for ⌥B), so recover the layout's base character for the
      // physical key; elsewhere e.key already is the right character.
      let ch: string | null = key.length === 1 ? key : null;
      if (IS_MAC && e.code.startsWith("Key")) {
        const base = layoutMap?.get(e.code) ?? e.code.slice(3).toLowerCase();
        ch = e.shiftKey ? base.toUpperCase() : base;
      } else if (IS_MAC && e.code.startsWith("Digit") && !e.shiftKey) ch = e.code.slice(5);
      if (key === " ") ch = " ";
      if (!ch) return null;
      // Ctrl+Alt+letter → ESC + control character.
      if (e.ctrlKey && /^[a-z]$/i.test(ch)) return "\x1b" + String.fromCharCode(ch.toLowerCase().charCodeAt(0) - 96);
      return "\x1b" + ch;
    }

    if (key.length === 1 || (key.length === 2 && key.codePointAt(0)! > 0xffff)) return key;
    return null;
  }

  // ───────────────────────────── mouse ─────────────────────────────

  private bindMouse() {
    const canvas = this.renderer.canvas;
    const pos = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return this.renderer.cellAt(e.clientX - r.left, e.clientY - r.top);
    };
    const reporting = (e: MouseEvent) => this.term.modes.mouse !== 0 && !e.shiftKey;
    let lastMotion = "";

    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.scrollbar || e.target === this.thumb) return;
      e.preventDefault();
      this.focus();
      const c = pos(e);
      if (reporting(e)) {
        this.mouseReport(e.button, c.x, c.y, true, e);
        const up = (ev: MouseEvent) => {
          window.removeEventListener("mouseup", up);
          const c2 = pos(ev);
          this.mouseReport(ev.button, c2.x, c2.y, false, ev);
        };
        window.addEventListener("mouseup", up);
        return;
      }
      if (e.button !== 0) return;
      if ((IS_MAC ? e.metaKey : e.ctrlKey) && this.activateLink(c.x, c.y)) return;

      const now = performance.now();
      const lc = this.lastClick;
      lc.n = now - lc.t < 400 && lc.x === c.x && lc.y === c.y ? (lc.n % 3) + 1 : 1;
      Object.assign(lc, { t: now, x: c.x, y: c.y });
      const p = this.toAbs(c.x, c.y);
      const mode = lc.n === 1 ? "char" : lc.n === 2 ? "word" : "line";
      if (e.shiftKey && this.renderer.selection) {
        this.renderer.selection.b = p;
        this.renderer.touchAll();
      } else {
        this.selecting = { anchor: p, mode };
        this.setSelection(p, p, mode, e.altKey);
        if (mode === "char") this.renderer.selection = null;
      }
      let scrollTimer = 0;
      let lastY = e.clientY;
      const move = (ev: MouseEvent) => {
        if (!this.selecting) return;
        lastY = ev.clientY;
        const c2 = pos(ev);
        this.setSelection(this.selecting.anchor, this.toAbs(c2.x, c2.y), this.selecting.mode, ev.altKey);
      };
      // Auto-scroll while dragging above/below the viewport.
      scrollTimer = window.setInterval(() => {
        const r = canvas.getBoundingClientRect();
        if (lastY < r.top) this.scrollBy(1);
        else if (lastY > r.bottom) this.scrollBy(-1);
      }, 50);
      const up = () => {
        clearInterval(scrollTimer);
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        this.selecting = null;
        const s = this.renderer.selection;
        if (s && s.a.row === s.b.row && s.a.col === s.b.col && lc.n === 1) this.clearSelection();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });

    this.el.addEventListener("mousemove", (e) => {
      const c = pos(e);
      if (this.term.modes.mouse >= 1002 && !e.shiftKey && (e.buttons || this.term.modes.mouse === 1003)) {
        const key = `${c.x},${c.y},${e.buttons}`;
        if (key !== lastMotion) {
          lastMotion = key;
          const btn = e.buttons & 1 ? 0 : e.buttons & 4 ? 1 : e.buttons & 2 ? 2 : 3;
          this.mouseReport(btn + 32, c.x, c.y, true, e);
        }
      }
      this.updateHover(c.x, c.y, IS_MAC ? e.metaKey : e.ctrlKey);
    });
    this.el.addEventListener("mouseleave", () => this.updateHover(-1, -1, false));

    this.el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / (this.renderer.ch / this.renderer.dpr);
        this.wheelAcc += lines;
        const n = Math.trunc(this.wheelAcc);
        if (!n) return;
        this.wheelAcc -= n;
        const c = pos(e);
        if (reporting(e)) {
          for (let i = 0; i < Math.min(Math.abs(n), 5); i++) this.mouseReport(n < 0 ? 64 : 65, c.x, c.y, true, e);
        } else if (this.term.alt) {
          if (this.term.modes.altScroll) {
            const seq = this.term.modes.appCursor ? (n < 0 ? "\x1bOA" : "\x1bOB") : n < 0 ? "\x1b[A" : "\x1b[B";
            this.opts.send(seq.repeat(Math.min(Math.abs(n), 10)));
          }
        } else this.scrollBy(-n);
      },
      { passive: false },
    );

    this.el.addEventListener("contextmenu", (e) => {
      if (this.term.modes.mouse) e.preventDefault();
    });

    // Scrollbar dragging
    this.thumb.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startOff = this.renderer.viewOffset;
      const total = this.term.totalLines;
      const h = this.scrollbar.clientHeight;
      const move = (ev: MouseEvent) => {
        const dy = ev.clientY - startY;
        const lines = Math.round((dy / h) * total);
        this.renderer.viewOffset = Math.max(0, Math.min(this.term.scrollback.length, startOff - lines));
        this.renderer.invalidate();
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  private wheelAcc = 0;

  private mouseReport(button: number, x: number, y: number, press: boolean, e: MouseEvent) {
    const mods = (e.shiftKey ? 4 : 0) | (e.altKey ? 8 : 0) | (e.ctrlKey ? 16 : 0);
    if (this.term.modes.mouseSgr) {
      this.opts.send(`\x1b[<${button | mods};${x + 1};${y + 1}${press ? "M" : "m"}`);
    } else {
      const b = (press || button >= 64 ? button : 3) | mods;
      if (x > 222 || y > 222) return;
      this.opts.send(`\x1b[M${String.fromCharCode(32 + b, 33 + x, 33 + y)}`);
    }
  }

  scrollBy(lines: number) {
    const r = this.renderer;
    const next = Math.max(0, Math.min(this.term.scrollback.length, r.viewOffset + lines));
    if (next !== r.viewOffset) {
      r.viewOffset = next;
      r.schedule();
    }
  }

  private updateScrollbar() {
    const total = this.term.totalLines;
    const rows = this.term.rows;
    if (total <= rows || this.term.alt) {
      this.scrollbar.style.display = "none";
      return;
    }
    this.scrollbar.style.display = "";
    const h = this.scrollbar.clientHeight;
    const th = Math.max(24, (rows / total) * h);
    const top = ((total - rows - this.renderer.viewOffset) / (total - rows)) * (h - th);
    this.thumb.style.height = `${th}px`;
    this.thumb.style.transform = `translateY(${top}px)`;
    this.scrollbar.classList.toggle("scrolled", this.renderer.viewOffset > 0);
  }

  // ───────────────────────────── selection ─────────────────────────────

  private toAbs(x: number, y: number): Point {
    return { row: this.term.scrollback.length - this.renderer.viewOffset + y, col: x };
  }

  private trimmedSeen = 0;

  private setSelection(a: Point, b: Point, mode: "char" | "word" | "line", block = false) {
    const t = this.term;
    this.trimmedSeen = t.trimmed;
    let [s, e] = b.row < a.row || (b.row === a.row && b.col < a.col) ? [b, a] : [a, b];
    s = { ...s };
    e = { ...e };
    if (mode === "word") {
      s.col = this.wordEdge(s.row, s.col, -1);
      e.col = this.wordEdge(e.row, e.col, 1);
    } else if (mode === "line") {
      s.col = 0;
      e.col = t.cols - 1;
    }
    const line = t.absLine(e.row);
    if (line && line.fl[e.col]! & WIDE) e.col++;
    this.renderer.selection = { a: s, b: e, block };
    this.renderer.touchAll();
  }

  private wordEdge(row: number, col: number, dir: 1 | -1): number {
    const line = this.term.absLine(row);
    if (!line) return col;
    const isWord = (ch: string | undefined) => !!ch && /[^\s()[\]{}<>"'`|│,;]/.test(ch);
    if (!isWord(line.text[col])) return col;
    while (col + dir >= 0 && col + dir < line.cols && (isWord(line.text[col + dir]) || line.text[col + dir] === "")) col += dir;
    return col;
  }

  private selectAll() {
    this.renderer.selection = { a: { row: 0, col: 0 }, b: { row: this.term.totalLines - 1, col: this.term.cols - 1 } };
    this.trimmedSeen = this.term.trimmed;
    this.renderer.touchAll();
  }

  clearSelection() {
    if (!this.renderer.selection) return;
    this.renderer.selection = null;
    this.renderer.touchAll();
  }

  selectionText(): string {
    const s = this.renderer.selection;
    if (!s || this.trimmedSeen !== this.term.trimmed) return "";
    let { a, b } = s;
    if (b.row < a.row || (b.row === a.row && b.col < a.col)) [a, b] = [b, a];
    const out: string[] = [];
    for (let r = a.row; r <= b.row; r++) {
      const line = this.term.absLine(r);
      if (!line) continue;
      const from = s.block ? Math.min(s.a.col, s.b.col) : r === a.row ? a.col : 0;
      const to = s.block ? Math.max(s.a.col, s.b.col) + 1 : r === b.row ? b.col + 1 : line.cols;
      let txt = line.text.slice(from, to).join("");
      const soft = line.wrapped && r !== b.row && !s.block;
      if (!soft) txt = txt.replace(/\s+$/, "");
      out.push(txt + (soft || r === b.row ? "" : "\n"));
    }
    return out.join("");
  }

  // ───────────────────────────── links ─────────────────────────────

  private linkAt(x: number, y: number): { start: number; end: number; target: string; uri?: string } | null {
    const line = this.term.viewLine(y, this.renderer.viewOffset);
    if (!line) return null;
    const id = line.fl[x]! >>> 16;
    if (id) {
      let start = x;
      let end = x + 1;
      while (start > 0 && line.fl[start - 1]! >>> 16 === id) start--;
      while (end < line.cols && line.fl[end]! >>> 16 === id) end++;
      return { start, end, target: this.term.links[id] ?? "", uri: this.term.links[id] };
    }
    // Map string offsets to columns (wide chars occupy two cells, one string slot).
    let text = "";
    const colOf: number[] = [];
    for (let i = 0; i < line.cols; i++) {
      const t = line.text[i]!;
      if (t === "") continue;
      for (let k = 0; k < t.length; k++) colOf.push(i);
      text += t;
    }
    colOf.push(line.cols);
    LINK_RE.lastIndex = 0;
    for (let m; (m = LINK_RE.exec(text)); ) {
      const start = colOf[m.index]!;
      const end = colOf[m.index + m[0].length]!;
      if (x >= start && x < end) return { start, end, target: m[0] };
    }
    return null;
  }

  private updateHover(x: number, y: number, active: boolean) {
    const r = this.renderer;
    const link = active && x >= 0 ? this.linkAt(x, y) : null;
    const next = link ? { row: this.term.scrollback.length - r.viewOffset + y, start: link.start, end: link.end } : null;
    const prev = r.hoverLink;
    if (prev?.row === next?.row && prev?.start === next?.start && prev?.end === next?.end) return;
    r.hoverLink = next;
    this.el.style.cursor = next ? "pointer" : "";
    r.touchAll();
  }

  private activateLink(x: number, y: number): boolean {
    const link = this.linkAt(x, y);
    if (!link) return false;
    const t = link.target;
    if (/^https?:\/\//.test(t)) {
      if (this.opts.onOpenUrl) this.opts.onOpenUrl(t);
      else window.open(t, "_blank", "noopener,noreferrer");
      return true;
    }
    if (t.startsWith("file://")) {
      try {
        this.opts.onOpenPath?.(decodeURIComponent(new URL(t).pathname), 0);
      } catch {}
      return true;
    }
    const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(t)!;
    this.opts.onOpenPath?.(m[1]!, Number(m[2] ?? 0));
    return true;
  }

  private restartBlink() {
    clearInterval(this.blinkTimer);
    this.renderer.cursorOn = true;
    this.renderer.schedule();
    if (!this.term.modes.cursorBlink) return;
    this.blinkTimer = window.setInterval(() => {
      if (!this.term.modes.cursorBlink) {
        this.renderer.cursorOn = true;
        return;
      }
      this.renderer.cursorOn = !this.renderer.cursorOn;
      this.renderer.schedule();
    }, 600);
  }
}
