import { Highlighter, type Tok } from "./highlight.ts";
import { esc, h } from "./util.ts";
import { icons } from "./icons.ts";
import { diffLines, gutterMarks, ADDED, MODIFIED, DELETED_BELOW, DELETED_ABOVE, type Hunk } from "./diff.ts";

const TOKS: Tok[] = ["k", "s", "c", "n", "f", "t", "p", "o", "v", "m", "h", "a", "x", "b", "i", "l"];
const TOK_ID = new Map(TOKS.map((t, i) => [t, i + 1]));
/** Lines rendered beyond the viewport; scrolling inside this margin needs no DOM work. */
const OVERSCAN = 40;
/** Syntax spans stop here on very long lines (minified code); the rest is plain text. */
const HIGHLIGHT_COLS = 1000;
const MAX_RENDER_COLS = 4000;

export interface CodeViewState {
  scrollTop: number;
  scrollLeft: number;
  activeLine: number;
}

/**
 * Virtualized, read-only code view: only visible lines exist in the DOM.
 * Highlighting is computed lazily per visible line by the incremental Highlighter.
 */
export class CodeView {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private sizer: HTMLElement;
  private linesEl: HTMLElement;
  private findBar: HTMLElement;
  private findInput: HTMLInputElement;
  private findCount: HTMLElement;
  private lines: string[] = [];
  private hl: Highlighter;
  private lh = 20;
  private charW = 7.8;
  private gutterW = 48;
  private frame = 0;
  private cache = new Map<number, string>();
  private changed: Uint8Array = new Uint8Array(0);
  private flash: { from: number; to: number; at: number } | null = null;
  activeLine = -1;
  onActiveLine: (line: number) => void = () => {};

  // git: HEAD content (null = not in a repo / unknown), diff hunks, per-line gutter flags
  private gitBase: string[] | null = null;
  private gitUntracked = false;
  private hunks: Hunk[] = [];
  private gitMarks: Uint8Array = new Uint8Array(0);
  private blame: { line: number; html: string } | null = null;
  private peek: HTMLElement | null = null;

  // find state
  private query = "";
  private opts = { caseSensitive: false, regex: false, word: false };
  private mLine: number[] = [];
  private mStart: number[] = [];
  private mEnd: number[] = [];
  private mCur = -1;

  constructor(
    text: string,
    private lang: string,
    fontSize: number,
  ) {
    this.linesEl = h("div", { class: "code-lines" });
    this.sizer = h("div", { class: "code-sizer" }, this.linesEl);
    this.scroller = h("div", { class: "code-scroll" }, this.sizer);
    this.findInput = h("input", { class: "find-input", placeholder: "Find", spellcheck: "false", "aria-label": "Find in file" });
    this.findCount = h("span", { class: "find-count" });
    const toggle = (label: string, key: keyof CodeView["opts"], title: string) => {
      const b = h("button", { class: "find-opt", title, "aria-pressed": "false" }, label);
      b.addEventListener("click", () => {
        this.opts[key] = !this.opts[key];
        b.setAttribute("aria-pressed", String(this.opts[key]));
        this.runFind();
        this.findInput.focus();
      });
      return b;
    };
    this.findBar = h(
      "div",
      { class: "findbar", hidden: true },
      h("span", { class: "find-icon", html: icons.search }),
      this.findInput,
      toggle("Aa", "caseSensitive", "Match case"),
      toggle("ab", "word", "Whole word"),
      toggle(".*", "regex", "Regular expression"),
      this.findCount,
      h("button", { class: "find-nav", title: "Previous (⇧Enter)", onclick: () => this.nextMatch(-1) }, "↑"),
      h("button", { class: "find-nav", title: "Next (Enter)", onclick: () => this.nextMatch(1) }, "↓"),
      h("button", { class: "find-nav", title: "Close (Esc)", html: icons.close, onclick: () => this.closeFind() }),
    );
    this.el = h("div", { class: "code" }, this.findBar, this.scroller);
    this.hl = new Highlighter(lang, []);
    this.setFontSize(fontSize);
    this.setText(text, false);

    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.findInput.addEventListener("input", () => this.runFind());
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.nextMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeFind();
      }
    });
    this.linesEl.addEventListener("mousedown", (e) => {
      const ln = (e.target as HTMLElement).closest<HTMLElement>(".ln");
      if (!ln) return;
      const n = Number(ln.dataset.n);
      if ((e.target as HTMLElement).classList.contains("g") && this.gitMarks[n]) {
        e.preventDefault();
        this.togglePeek(n, ln);
        return;
      }
      this.setActiveLine(n);
    });
    this.scroller.addEventListener("scroll", () => this.closePeek(), { passive: true });
  }

  get lineCount() {
    return this.lines.length;
  }

  setFontSize(px: number) {
    this.el.style.setProperty("--code-size", `${px}px`);
    this.lh = Math.round(px * 1.6); // panel decision: generous leading for scanning code
    this.el.style.setProperty("--lh", `${this.lh}px`);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${px}px ${getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace"}`;
    this.charW = ctx.measureText("0123456789").width / 10;
    this.relayout();
  }

  /** Replaces the content (e.g. after the file changed on disk), keeping scroll and flashing changed lines. */
  setText(text: string, diff = true) {
    const next = text.split(/\r\n|\r|\n/);
    if (next.length > 1 && next[next.length - 1] === "") next.pop();
    if (diff && this.lines.length) {
      const old = this.lines;
      let a = 0;
      while (a < old.length && a < next.length && old[a] === next[a]) a++;
      let b = 0;
      while (b < old.length - a && b < next.length - a && old[old.length - 1 - b] === next[next.length - 1 - b]) b++;
      const changed = new Uint8Array(next.length);
      changed.set(this.changed.subarray(0, a));
      changed.fill(1, a, next.length - b);
      if (b) changed.set(this.changed.subarray(old.length - b), next.length - b);
      this.changed = changed;
      if (next.length - b > a) this.flash = { from: a, to: next.length - b, at: performance.now() };
    } else {
      this.changed = new Uint8Array(next.length);
    }
    this.lines = next;
    this.hl = new Highlighter(this.lang, next);
    this.cache.clear();
    this.blame = null;
    this.closePeek();
    this.recomputeGit();
    if (this.query) this.runFind(false);
    this.relayout();
  }

  // ───────────────────────────── git ─────────────────────────────

  /**
   * Sets the HEAD version for gutter markers. `base` null with `untracked` true marks every
   * line as added; null without it clears git markers (not in a repo, binary, ignored).
   */
  setGit(base: string | null, untracked: boolean) {
    this.gitBase = base === null ? null : base === "" ? [] : base.split(/\r\n|\r|\n/);
    if (this.gitBase && this.gitBase.length > 1 && this.gitBase[this.gitBase.length - 1] === "") this.gitBase.pop();
    this.gitUntracked = untracked;
    this.recomputeGit();
    this.schedule();
  }

  private recomputeGit() {
    const n = this.lines.length;
    if (this.gitUntracked) {
      this.hunks = [{ a0: 0, a1: 0, b0: 0, b1: n }];
      this.gitMarks = new Uint8Array(n).fill(ADDED);
    } else if (this.gitBase) {
      this.hunks = diffLines(this.gitBase, this.lines);
      this.gitMarks = gutterMarks(this.hunks, n);
    } else {
      this.hunks = [];
      this.gitMarks = new Uint8Array(n);
    }
  }

  /** Lines changed vs HEAD: [added, modified-or-replaced, deleted]. */
  get gitStats(): { added: number; removed: number } | null {
    if (!this.gitBase && !this.gitUntracked) return null;
    let added = 0;
    let removed = 0;
    for (const h of this.hunks) {
      added += h.b1 - h.b0;
      removed += h.a1 - h.a0;
    }
    return { added, removed };
  }

  /** Jumps to the next/previous change vs HEAD (wraps around). */
  nextChange(dir: 1 | -1) {
    if (!this.hunks.length) return;
    const cur = this.activeLine >= 0 ? this.activeLine : Math.floor(this.scroller.scrollTop / this.lh);
    const starts = this.hunks.map((h) => Math.min(h.b0, Math.max(0, this.lines.length - 1)));
    const next = dir > 0 ? starts.find((b) => b > cur) ?? starts[0]! : [...starts].reverse().find((b) => b < cur) ?? starts[starts.length - 1]!;
    this.revealLine(next);
  }

  /** Inline blame annotation shown at the end of the active line. */
  setBlame(line: number, html: string | null) {
    this.blame = html === null ? null : { line, html };
    this.schedule();
  }

  private hunkAt(line: number): Hunk | undefined {
    const m = this.gitMarks[line]!;
    return this.hunks.find((h) =>
      (h.b1 > h.b0 && line >= h.b0 && line < h.b1) ||
      (h.b1 === h.b0 && ((m & DELETED_BELOW && h.b0 === line + 1) || (m & DELETED_ABOVE && h.b0 === 0 && line === 0))),
    );
  }

  /** Read-only peek at what HEAD had for the change under `line`. */
  private togglePeek(line: number, rowEl: HTMLElement) {
    const hk = this.hunkAt(line);
    if (!hk || (this.peek && this.peek.dataset.hunk === `${hk.b0}:${hk.a0}`)) return this.closePeek();
    this.closePeek();
    const removed = this.gitBase?.slice(hk.a0, hk.a1) ?? [];
    const addedN = hk.b1 - hk.b0;
    const title =
      this.gitUntracked ? "Untracked file: not in HEAD" :
      removed.length && addedN ? `Changed: ${removed.length} line${removed.length === 1 ? "" : "s"} in HEAD → ${addedN} now` :
      removed.length ? `Deleted: ${removed.length} line${removed.length === 1 ? "" : "s"} from HEAD` :
      `Added: ${addedN} new line${addedN === 1 ? "" : "s"}`;
    const body = removed.length
      ? `<div class="peek-code">${removed.map((l, i) => `<div class="peek-line"><span class="peek-n">${hk.a0 + i + 1}</span><span class="peek-t">${esc(l) || " "}</span></div>`).join("")}</div>`
      : "";
    const box = h("div", { class: "peek", role: "dialog", "aria-label": title },
      h("div", { class: "peek-head" }, h("span", { class: "peek-badge" }, "HEAD"), h("span", null, title),
        h("button", { class: "find-nav", title: "Close (Esc)", html: icons.close, onclick: () => this.closePeek() })),
    );
    box.insertAdjacentHTML("beforeend", body);
    box.dataset.hunk = `${hk.b0}:${hk.a0}`;
    const host = this.el.getBoundingClientRect();
    const row = rowEl.getBoundingClientRect();
    box.style.top = `${row.bottom - host.top + 2}px`;
    box.style.left = `${this.gutterW - 6}px`;
    this.el.append(box);
    this.peek = box;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closePeek();
    };
    const onDown = (e: MouseEvent) => {
      if (!box.contains(e.target as Node) && !(e.target as HTMLElement).classList.contains("g")) this.closePeek();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    box.addEventListener("peek-close", () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    });
  }

  private closePeek() {
    if (!this.peek) return;
    this.peek.dispatchEvent(new Event("peek-close"));
    this.peek.remove();
    this.peek = null;
  }

  private relayout() {
    let max = 0;
    const lines = this.lines;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.length > max) max = l.length + (l.includes("\t") ? countTabs(l) * 3 : 0);
    }
    max = Math.min(max, MAX_RENDER_COLS);
    const digits = String(lines.length).length;
    this.gutterW = Math.round(Math.max(3, digits) * this.charW + 34);
    this.el.style.setProperty("--gutter", `${this.gutterW}px`);
    this.sizer.style.height = `${lines.length * this.lh + 8}px`;
    this.sizer.style.width = `${Math.ceil(this.gutterW + max * this.charW + 48)}px`;
    this.cache.clear();
    this.schedule();
  }

  private window = { first: 0, last: -1 };
  private stale = true;

  schedule() {
    this.stale = true;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  /** Scrolling re-renders only when the viewport leaves the rendered window. */
  private onScroll() {
    const top = this.scroller.scrollTop;
    const firstVisible = Math.floor(top / this.lh);
    const lastVisible = Math.ceil((top + (this.scroller.clientHeight || 800)) / this.lh);
    if ((firstVisible < this.window.first || lastVisible > this.window.last) && !this.frame) {
      this.frame = requestAnimationFrame(() => this.render());
    }
  }

  private render() {
    this.frame = 0;
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight || 800;
    const first = Math.max(0, Math.floor(top / this.lh) - OVERSCAN);
    const last = Math.min(this.lines.length, Math.ceil((top + height) / this.lh) + OVERSCAN);
    if (!this.stale && first >= this.window.first && last <= this.window.last) return;
    this.stale = false;
    this.window = { first, last: first === 0 && last === this.lines.length ? Infinity : last };
    const now = performance.now();
    if (this.flash && now - this.flash.at > 2000) this.flash = null;
    let html = "";
    for (let i = first; i < last; i++) {
      let cls = "ln";
      if (i === this.activeLine) cls += " active";
      if (this.changed[i]) cls += " mod";
      const gm = this.gitMarks[i]!;
      if (gm & ADDED) cls += " git-add";
      else if (gm & MODIFIED) cls += " git-mod";
      if (gm & DELETED_BELOW) cls += " git-del-below";
      if (gm & DELETED_ABOVE) cls += " git-del-above";
      let style = "";
      if (this.flash && i >= this.flash.from && i < this.flash.to) {
        cls += " flash";
        style = ` style="animation-delay:${-(now - this.flash.at) | 0}ms"`;
      }
      const blame = this.blame && this.blame.line === i ? `<span class="blame">${this.blame.html}</span>` : "";
      html += `<div class="${cls}" data-n="${i}"${style}><span class="g">${i + 1}</span><span class="tx">${this.lineHtml(i)}</span>${blame}</div>`;
    }
    this.linesEl.style.transform = `translateY(${first * this.lh}px)`;
    this.linesEl.innerHTML = html;
  }

  private lineHtml(i: number): string {
    const hasMarks = this.query && this.mLine.length;
    if (!hasMarks) {
      const c = this.cache.get(i);
      if (c !== undefined) return c;
    }
    let text = this.lines[i]!;
    let truncated = false;
    if (text.length > MAX_RENDER_COLS) {
      text = text.slice(0, MAX_RENDER_COLS);
      truncated = true;
    }
    const n = text.length;
    if (n === 0) return "";
    const cls = new Uint8Array(n);
    const hlEnd = Math.min(n, HIGHLIGHT_COLS);
    for (const [s, e, t] of this.hl.line(i)) if (s < hlEnd) cls.fill(TOK_ID.get(t)!, s, Math.min(e, hlEnd));
    let mark: Uint8Array | null = null;
    if (hasMarks) {
      let k = lowerBound(this.mLine, i);
      while (k < this.mLine.length && this.mLine[k] === i) {
        mark ??= new Uint8Array(n);
        mark.fill(k === this.mCur ? 2 : 1, this.mStart[k]!, Math.min(this.mEnd[k]!, n));
        k++;
      }
    }
    let out = "";
    let s = 0;
    for (let p = 1; p <= n; p++) {
      if (p === n || cls[p] !== cls[s] || (mark && mark[p] !== mark[s])) {
        const seg = esc(text.slice(s, p));
        const t = cls[s] ? TOKS[cls[s]! - 1] : "";
        const m = mark?.[s];
        let piece = t ? `<span class="t-${t}">${seg}</span>` : seg;
        if (m) piece = `<mark${m === 2 ? ' class="cur"' : ""}>${piece}</mark>`;
        out += piece;
        s = p;
      }
    }
    if (truncated) out += `<span class="trunc"> … ${(this.lines[i]!.length - MAX_RENDER_COLS).toLocaleString()} more characters</span>`;
    if (!hasMarks && this.cache.size < 20000) this.cache.set(i, out);
    return out;
  }

  setActiveLine(n: number) {
    this.activeLine = n;
    this.onActiveLine(n);
    this.schedule();
  }

  /** Scrolls so that 0-based `line` is visible (centered when far away). */
  revealLine(line: number, select = true) {
    line = Math.max(0, Math.min(this.lines.length - 1, line));
    const top = line * this.lh;
    const s = this.scroller;
    if (top < s.scrollTop || top + this.lh > s.scrollTop + s.clientHeight) s.scrollTop = top - s.clientHeight / 3;
    if (select) this.setActiveLine(line);
  }

  getState(): CodeViewState {
    return { scrollTop: this.scroller.scrollTop, scrollLeft: this.scroller.scrollLeft, activeLine: this.activeLine };
  }

  setState(st: CodeViewState) {
    this.scroller.scrollTop = st.scrollTop;
    this.scroller.scrollLeft = st.scrollLeft;
    this.activeLine = st.activeLine;
    this.schedule();
  }

  focus() {
    this.scroller.focus({ preventScroll: true });
  }

  // ───────────────────────────── find ─────────────────────────────

  openFind() {
    this.findBar.hidden = false;
    const sel = window.getSelection()?.toString();
    if (sel && !sel.includes("\n")) this.findInput.value = sel;
    this.findInput.focus();
    this.findInput.select();
    this.runFind();
  }

  closeFind() {
    this.findBar.hidden = true;
    this.query = "";
    this.mLine = [];
    this.cache.clear();
    this.schedule();
    this.scroller.focus();
  }

  private runFind(reveal = true) {
    const q = this.findInput.value;
    this.query = q;
    this.mLine = [];
    this.mStart = [];
    this.mEnd = [];
    this.mCur = -1;
    this.findBar.classList.remove("error");
    if (q) {
      let re: RegExp;
      try {
        let src = this.opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (this.opts.word) src = `\\b(?:${src})\\b`;
        re = new RegExp(src, this.opts.caseSensitive ? "g" : "gi");
      } catch {
        this.findBar.classList.add("error");
        this.findCount.textContent = "Invalid";
        this.schedule();
        return;
      }
      const lines = this.lines;
      outer: for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        for (let m; (m = re.exec(lines[i]!)); ) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          this.mLine.push(i);
          this.mStart.push(m.index);
          this.mEnd.push(m.index + m[0].length);
          if (this.mLine.length >= 50_000) break outer;
        }
      }
      // Start from the first match at or after the current viewport.
      const fromLine = this.activeLine >= 0 ? this.activeLine : Math.floor(this.scroller.scrollTop / this.lh);
      if (this.mLine.length) this.mCur = Math.min(lowerBound(this.mLine, fromLine), this.mLine.length - 1);
    }
    this.updateCount();
    this.cache.clear();
    if (reveal && this.mCur >= 0) this.revealLine(this.mLine[this.mCur]!, false);
    this.schedule();
  }

  private updateCount() {
    const n = this.mLine.length;
    this.findCount.textContent = !this.query ? "" : n ? `${this.mCur + 1} of ${n >= 50_000 ? "50k+" : n}` : "No results";
    this.findBar.classList.toggle("none", !!this.query && !n);
  }

  nextMatch(dir: 1 | -1) {
    const n = this.mLine.length;
    if (!n) return;
    this.mCur = (this.mCur + dir + n) % n;
    this.updateCount();
    this.revealLine(this.mLine[this.mCur]!, false);
    // Bring the match into view horizontally too.
    const x = this.gutterW + this.mStart[this.mCur]! * this.charW;
    const s = this.scroller;
    if (x < s.scrollLeft + this.gutterW || x > s.scrollLeft + s.clientWidth - 40) s.scrollLeft = Math.max(0, x - s.clientWidth / 2);
    this.schedule();
  }
}

function countTabs(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 9) n++;
  return n;
}

function lowerBound(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
