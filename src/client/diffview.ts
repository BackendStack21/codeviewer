import { diffLines, type Hunk } from "./diff.ts";
import { Highlighter, type Tok } from "./highlight.ts";
import { icons } from "./icons.ts";
import { basename, dirname, esc, h, showHidden } from "./util.ts";
import type { Letter } from "./git.ts";

const TOKS: Tok[] = ["k", "s", "c", "n", "f", "t", "p", "o", "v", "m", "h", "a", "x", "b", "i", "l"];
const TOK_ID = new Map(TOKS.map((t, i) => [t, i + 1]));
const OVERSCAN = 30;
const MAX_COLS = 4000;
/** Unchanged lines kept on each side of a change; longer runs collapse into one expandable row. */
export const CONTEXT = 3;

export type DiffRow =
  | { k: "ctx"; a: number; b: number }
  | { k: "del"; a: number; hk: number }
  | { k: "add"; b: number; hk: number }
  /** `n` unchanged lines hidden: old lines from `a`, new lines from `b`; `g` indexes the gap. */
  | { k: "gap"; a: number; b: number; n: number; g: number };

/**
 * Unified rows for `hunks` (old lines [a0,a1) replaced by new lines [b0,b1)) over an old file of
 * `aLen` lines and a new one of `bLen`. Unchanged runs show CONTEXT lines next to each change;
 * the rest of a run collapses into a "gap" row unless its index is in `open`.
 */
export function buildRows(hunks: readonly Hunk[], aLen: number, bLen: number, open: ReadonlySet<number>, ctx = CONTEXT): DiffRow[] {
  const rows: DiffRow[] = [];
  let a = 0;
  let b = 0;
  let g = 0;
  const run = (toA: number, first: boolean, last: boolean) => {
    const n = toA - a;
    const lead = first ? 0 : Math.min(ctx, n); // lines kept after the previous change
    const trail = last ? 0 : Math.min(ctx, n - lead); // lines kept before the next change
    const hidden = n - lead - trail;
    const show = hidden <= 1 || open.has(g); // never hide a single line behind a click
    const gi = g;
    if (hidden > 0) g++;
    for (let i = 0; i < n; i++) {
      if (!show && i === lead) {
        rows.push({ k: "gap", a, b, n: hidden, g: gi });
        a += hidden;
        b += hidden;
        i += hidden - 1;
        continue;
      }
      rows.push({ k: "ctx", a: a++, b: b++ });
    }
  };
  hunks.forEach((hk, i) => {
    run(hk.a0, i === 0, false);
    for (let x = hk.a0; x < hk.a1; x++) rows.push({ k: "del", a: x, hk: i });
    for (let y = hk.b0; y < hk.b1; y++) rows.push({ k: "add", b: y, hk: i });
    a = hk.a1;
    b = hk.b1;
  });
  if (hunks.length) run(aLen, false, true);
  void bLen;
  return rows;
}

/** Highlighted HTML for one line, from the lexer's spans (same classes as the code view). */
export function spansHtml(text: string, spans: readonly [number, number, Tok][]): string {
  if (text.length > MAX_COLS) text = text.slice(0, MAX_COLS);
  const n = text.length;
  if (n === 0) return "";
  const cls = new Uint8Array(n);
  for (const [s, e, t] of spans) if (s < n) cls.fill(TOK_ID.get(t)!, s, Math.min(e, n));
  let out = "";
  let s = 0;
  for (let p = 1; p <= n; p++) {
    if (p === n || cls[p] !== cls[s]) {
      const seg = esc(showHidden(text.slice(s, p)));
      const t = cls[s] ? TOKS[cls[s]! - 1] : "";
      out += t ? `<span class="t-${t}">${seg}</span>` : seg;
      s = p;
    }
  }
  return out;
}

export interface DiffInfo {
  path: string;
  oldPath?: string;
  letter: Letter;
  /** "Modified", "Deleted", … */
  label: string;
  /** What the old side is: "vs main", "vs HEAD". */
  vs: string;
}

const splitLines = (t: string) => {
  const l = t.split(/\r\n|\r|\n/);
  if (l.length > 1 && l[l.length - 1] === "") l.pop();
  return t === "" ? [] : l;
};

/**
 * Read-only unified diff of one file: two line-number columns, a +/− marker, highlighted text,
 * collapsed context with expandable gaps. Virtualized like the code view.
 */
export class DiffView {
  readonly el: HTMLElement;
  onOpenFile: () => void = () => {};
  onStep: (dir: 1 | -1) => void = () => {};
  private head: HTMLElement;
  private pathEl: HTMLElement;
  private countsEl: HTMLElement;
  private vsEl: HTMLElement;
  private posEl: HTMLElement;
  private posWrap: HTMLElement;
  private badge: HTMLElement;
  private scroller: HTMLElement;
  private sizer: HTMLElement;
  private rowsEl: HTMLElement;
  private notice: HTMLElement;
  private oldLines: string[] = [];
  private newLines: string[] = [];
  private hlA: Highlighter;
  private hlB: Highlighter;
  private hunks: Hunk[] = [];
  private rows: DiffRow[] = [];
  private open = new Set<number>();
  private lh = 20;
  private frame = 0;
  private stale = true;
  private window = { first: 0, last: -1 };
  private cur = -1;
  private flashAt = 0;
  private ro: ResizeObserver | null = null;

  constructor(
    private info: DiffInfo,
    private lang: string,
    fontSize: number,
  ) {
    this.badge = h("span", { class: "gbadge" });
    this.pathEl = h("span", { class: "diff-path" });
    this.countsEl = h("span", { class: "diff-counts" });
    this.vsEl = h("span", { class: "diff-vs" });
    this.posEl = h("span", { class: "diff-n" });
    this.head = h(
      "div",
      { class: "diff-head" },
      this.badge,
      this.pathEl,
      this.countsEl,
      this.vsEl,
      (this.posWrap = h(
        "span",
        { class: "diff-pos" },
        h("button", { class: "find-nav", title: "Previous changed file (⌥⇧F5 at the first change)", onclick: () => this.onStep(-1) }, "‹"),
        this.posEl,
        h("button", { class: "find-nav", title: "Next changed file (⌥F5 at the last change)", onclick: () => this.onStep(1) }, "›"),
      )),
      h("button", { class: "diff-open", type: "button", title: "Open the file in the code view", onclick: () => this.onOpenFile() }, h("span", { html: icons.code }), "Open file"),
    );
    this.rowsEl = h("div", { class: "diff-rows" });
    this.sizer = h("div", { class: "diff-sizer" }, this.rowsEl);
    this.notice = h("div", { class: "diff-notice", hidden: true });
    this.scroller = h("div", { class: "diff-scroll", tabindex: "0" }, this.notice, this.sizer);
    this.el = h("div", { class: "diffview" }, this.head, this.scroller);
    this.hlA = new Highlighter(lang, []);
    this.hlB = new Highlighter(lang, []);
    this.setFontSize(fontSize);
    this.setInfo(info);
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(this.scroller);
    const openGap = (e: Event) => {
      const gap = (e.target as HTMLElement).closest<HTMLElement>(".dr-gap");
      if (!gap) return;
      e.preventDefault();
      this.open.add(Number(gap.dataset.g));
      this.rebuild();
    };
    this.rowsEl.addEventListener("click", openGap);
    this.rowsEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") openGap(e);
    });
  }

  setInfo(info: DiffInfo) {
    this.info = info;
    this.badge.className = `gbadge git-${info.letter}`;
    this.badge.textContent = info.letter;
    this.badge.title = info.label;
    const name = (p: string) => `<span class="diff-dir">${esc(showHidden(dirname(p)))}${dirname(p) ? "/" : ""}</span>${esc(showHidden(basename(p)))}`;
    this.pathEl.innerHTML = info.oldPath !== undefined && info.oldPath !== info.path ? `${name(info.oldPath)}<span class="ch-arrow">→</span>${name(info.path)}` : name(info.path);
    this.vsEl.textContent = info.vs;
  }

  /** "3/7" in the header; hidden when the file is not in the list. */
  setPosition(pos: { i: number; n: number } | null) {
    this.posEl.textContent = pos ? `${pos.i}/${pos.n}` : "";
    this.posWrap.hidden = !pos;
  }

  setFontSize(px: number) {
    this.el.style.setProperty("--code-size", `${px}px`);
    this.lh = Math.round(px * 1.6);
    this.el.style.setProperty("--lh", `${this.lh}px`);
    this.stale = true;
    this.relayout();
  }

  /**
   * Sets both sides (null = that side cannot be shown) and re-diffs, keeping the scroll position.
   * `note` replaces the rows with a message (binary, too large).
   */
  setTexts(oldText: string | null, newText: string | null, note?: string) {
    const top = this.scroller.scrollTop;
    if (note || oldText === null || newText === null) {
      this.oldLines = [];
      this.newLines = [];
      this.hunks = [];
      this.rows = [];
      this.showNotice(
        note ??
          (oldText === null && newText === null
            ? "This change can't be shown."
            : `The ${oldText === null ? "previous" : "current"} version can't be shown (binary or too large).`),
      );
    } else {
      this.oldLines = splitLines(oldText ?? "");
      this.newLines = splitLines(newText ?? "");
      this.hlA = new Highlighter(this.lang, this.oldLines);
      this.hlB = new Highlighter(this.lang, this.newLines);
      const hunks = diffLines(this.oldLines, this.newLines);
      // A reload that keeps the same number of hunks (an edit inside one) keeps the opened gaps
      // and the current hunk; anything else starts over.
      if (hunks.length !== this.hunks.length) {
        this.open.clear();
        this.cur = -1;
      }
      this.hunks = hunks;
      if (this.hunks.length) {
        this.notice.hidden = true;
        this.rows = buildRows(this.hunks, this.oldLines.length, this.newLines.length, this.open);
      } else {
        this.rows = [];
        // The line diff ignores CR LF vs LF and a missing final newline; git does not.
        this.showNotice(oldText === newText ? "No differences." : "Only line endings or the final newline changed.");
      }
    }
    if (this.cur >= this.hunks.length) this.cur = -1;
    this.updateCounts();
    this.relayout();
    this.scroller.scrollTop = Math.min(top, Math.max(0, this.rows.length * this.lh - (this.scroller.clientHeight || 0)));
  }

  private showNotice(msg: string) {
    this.notice.textContent = msg;
    this.notice.hidden = false;
  }

  get stats(): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const hk of this.hunks) {
      added += hk.b1 - hk.b0;
      removed += hk.a1 - hk.a0;
    }
    return { added, removed };
  }

  get hunkCount() {
    return this.hunks.length;
  }

  private updateCounts() {
    const { added, removed } = this.stats;
    this.countsEl.innerHTML = `${added ? `<span class="git-A">+${added.toLocaleString()}</span>` : ""}${removed ? `<span class="git-D">−${removed.toLocaleString()}</span>` : ""}`;
  }

  /**
   * Scrolls to the next/previous change. Returns false instead of wrapping when there is no change
   * further in that direction (the caller then moves on to the next file).
   */
  nextChange(dir: 1 | -1): boolean {
    const n = this.hunks.length;
    if (!n) return false;
    const next = this.cur < 0 ? (dir === 1 ? 0 : n - 1) : this.cur + dir;
    if (next < 0 || next >= n) return false;
    this.showHunk(next);
    return true;
  }

  /** Reveals hunk `i` (0-based), opening any gap that hides its neighbourhood. */
  showHunk(i: number) {
    this.cur = i;
    const row = this.rows.findIndex((r) => (r.k === "del" || r.k === "add") && r.hk === i);
    if (row < 0) return;
    const top = row * this.lh;
    const s = this.scroller;
    const ch = s.clientHeight || 800;
    if (top < s.scrollTop || top + this.lh > s.scrollTop + ch) s.scrollTop = Math.max(0, top - ch / 3);
    this.flashAt = performance.now();
    this.stale = true;
    this.schedule();
  }

  focus() {
    this.scroller.focus();
  }

  /** Stops observing and cancels a pending frame (the tab was closed or its view replaced). */
  dispose() {
    this.ro?.disconnect();
    this.ro = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private rebuild() {
    const top = this.scroller.scrollTop;
    this.rows = buildRows(this.hunks, this.oldLines.length, this.newLines.length, this.open);
    this.relayout();
    this.scroller.scrollTop = top;
  }

  private relayout() {
    const digits = (n: number) => Math.max(2, String(n).length);
    this.el.style.setProperty("--dn-a", `${digits(this.oldLines.length)}ch`);
    this.el.style.setProperty("--dn-b", `${digits(this.newLines.length)}ch`);
    this.sizer.style.height = `${this.rows.length * this.lh + 8}px`;
    this.stale = true;
    this.schedule();
  }

  schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  private onScroll() {
    const top = this.scroller.scrollTop;
    const first = Math.floor(top / this.lh);
    const last = Math.ceil((top + (this.scroller.clientHeight || 800)) / this.lh);
    if ((first < this.window.first || last > this.window.last) && !this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  private render() {
    this.frame = 0;
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight || 800;
    const first = Math.max(0, Math.floor(top / this.lh) - OVERSCAN);
    const last = Math.min(this.rows.length, Math.ceil((top + height) / this.lh) + OVERSCAN);
    if (!this.stale && first >= this.window.first && last <= this.window.last) return;
    this.stale = false;
    this.window = { first, last: first === 0 && last === this.rows.length ? Infinity : last };
    const flash = performance.now() - this.flashAt < 1500;
    let html = "";
    for (let i = first; i < last; i++) {
      const r = this.rows[i]!;
      if (r.k === "gap") {
        html += `<div class="dr dr-gap" data-g="${r.g}" role="button" tabindex="0" title="Show these lines"><span class="dn"></span><span class="dn"></span><span class="dm">⋯</span><span class="dt">${r.n.toLocaleString()} unchanged lines</span></div>`;
        continue;
      }
      let cls = `dr dr-${r.k}`;
      if ((r.k === "del" || r.k === "add") && r.hk === this.cur) cls += ` cur${flash ? " flash" : ""}`;
      const a = r.k === "add" ? "" : String(r.a + 1);
      const b = r.k === "del" ? "" : String(r.b + 1);
      const text = r.k === "del" ? this.oldLines[r.a]! : this.newLines[r.k === "add" ? r.b : r.b]!;
      const spans = r.k === "del" ? this.hlA.line(r.a) : this.hlB.line(r.k === "add" ? r.b : r.b);
      const mark = r.k === "del" ? "−" : r.k === "add" ? "+" : " ";
      html += `<div class="${cls}"><span class="dn">${a}</span><span class="dn">${b}</span><span class="dm">${mark}</span><span class="dt">${spansHtml(text, spans)}</span></div>`;
    }
    this.rowsEl.style.transform = `translateY(${first * this.lh}px)`;
    this.rowsEl.innerHTML = html;
  }
}
