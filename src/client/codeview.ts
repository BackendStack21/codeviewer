import { Highlighter, type Tok } from "./highlight.ts";
import { dismissable, esc, h } from "./util.ts";
import { icons } from "./icons.ts";
import { allRange, normalize, restorePlan, selectionText, type SelRange } from "./selection.ts";
import { diffLines, gutterMarks, ADDED, MODIFIED, DELETED_BELOW, DELETED_ABOVE, type Hunk } from "./diff.ts";

const TOKS: Tok[] = ["k", "s", "c", "n", "f", "t", "p", "o", "v", "m", "h", "a", "x", "b", "i", "l"];
const TOK_ID = new Map(TOKS.map((t, i) => [t, i + 1]));
/** Lines rendered beyond the viewport; scrolling inside this margin needs no DOM work. */
const OVERSCAN = 40;
/** Syntax spans stop here on very long lines (minified code); the rest is plain text. */
const HIGHLIGHT_COLS = 1000;
const MAX_RENDER_COLS = 4000;

/** One highlighted range of a line; `cur` marks the current match. */
export interface MarkRange {
  start: number;
  end: number;
  cur?: boolean;
}

/**
 * Merges ranges into a per-column mark map for a line of `n` columns: 1 = match, 2 = current match
 * (which wins over overlapping matches). Ranges are clamped to [0, n); null when nothing is marked.
 */
export function markRanges(n: number, ranges: readonly MarkRange[]): Uint8Array | null {
  let out: Uint8Array | null = null;
  for (const r of ranges) {
    const s = Math.max(0, r.start);
    const e = Math.min(n, r.end);
    if (s >= e) continue;
    out ??= new Uint8Array(n);
    const v = r.cur ? 2 : 1;
    for (let i = s; i < e; i++) if (out[i]! < v) out[i] = v;
  }
  return out;
}

/** New scrollLeft that brings 0-based column `col` into view, or `scrollLeft` when it already is. */
export function revealCol(scrollLeft: number, clientWidth: number, gutterW: number, charW: number, col: number): number {
  const x = gutterW + Math.min(col, MAX_RENDER_COLS) * charW;
  if (x < scrollLeft + gutterW || x > scrollLeft + clientWidth - 40) return Math.max(0, x - clientWidth / 2);
  return scrollLeft;
}

export interface CodeViewState {
  scrollTop: number;
  scrollLeft: number;
  activeLine: number;
}

/**
 * Virtualized, read-only code view: only visible lines exist in the DOM.
 * Highlighting is computed lazily per visible line by the incremental Highlighter.
 */
/** The view the user last pressed in; document-level Cmd+A / copy only act for it. */
let current: CodeView | null = null;

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
  /** Range opened from a project search result: 0-based line, column span. */
  private sr: { line: number; start: number; end: number } | null = null;

  constructor(
    text: string,
    private lang: string,
    fontSize: number,
  ) {
    current = null; // a new file starts without a pointer interaction
    this.linesEl = h("div", { class: "code-lines" });
    this.sizer = h("div", { class: "code-sizer" }, this.linesEl);
    this.scroller = h("div", { class: "code-scroll", tabindex: "-1" }, this.sizer);
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
      this.held = !e.button && !e.ctrlKey; // a new press supersedes a hold whose mouseup was lost
      const ln = (e.target as HTMLElement).closest<HTMLElement>(".ln");
      if (!ln) return;
      const n = Number(ln.dataset.n);
      current = this;
      if (e.button || e.ctrlKey) return this.setActiveLine(n); // right press / Ctrl+click opens the menu: keep the range
      this.sel = null;
      this.applied = null;
      current = this;
      if ((e.target as HTMLElement).classList.contains("g") && this.gitMarks[n]) {
        e.preventDefault();
        this.togglePeek(n, ln);
        return;
      }
      this.setActiveLine(n);
    });
    // A press in the scroller's blank area (beside short lines, below the text) also starts a drag.
    this.scroller.addEventListener("mousedown", (e) => {
      if (!e.button && !e.ctrlKey) this.held = true;
    });
    this.scroller.addEventListener("scroll", () => this.closePeek(), { passive: true });
    // Focus does not reliably sit on the scroller (a press on code text may leave it on <body>), so the
    // key and copy handling also listens on the document and checks that this view is the one in use.
    const selectAllKey = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a";
    this.scroller.addEventListener("keydown", (e) => {
      if (!selectAllKey(e)) return;
      e.preventDefault();
      this.selectAll();
    });
    document.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || !this.active || !selectAllKey(e) || isEditable(e.target)) return;
      e.preventDefault();
      this.selectAll();
    });
    // Also fires for the WebView's native Edit / context-menu Copy.
    const onCopy = (e: ClipboardEvent) => {
      if (e.defaultPrevented || !this.sel || isEditable(e.target)) return;
      const ds = window.getSelection?.();
      const live = !!ds && ds.rangeCount > 0 && !ds.isCollapsed;
      const inside = live && (this.el.contains(ds!.anchorNode) || this.el.contains(ds!.focusNode));
      if (live ? !inside : !this.active) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", this.selectedText());
    };
    this.scroller.addEventListener("copy", (e) => {
      if (!this.sel) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", this.selectedText());
    });
    document.addEventListener("copy", onCopy);
    document.addEventListener("selectionchange", () => {
      this.readDomSelection();
      this.syncBlame(); // a selection hides the label only while it exists
    });
    const release = () => {
      if (!this.held) return;
      this.held = false;
      this.syncBlame();
    };
    document.addEventListener("mouseup", release);
    window.addEventListener("blur", release);
    document.addEventListener("mousemove", (e) => {
      if (this.held && e.buttons === 0) release(); // the button was released outside the page
    });
    // A primary press outside the whole view makes the model range stale.
    document.addEventListener("mousedown", (e) => {
      const t = e.target as Node | null;
      const inside = this.el.contains(t) || this.linesEl.contains(t);
      if (inside) current = this;
      else if (current === this) current = null;
      if (e.button || e.ctrlKey || !this.sel || inside) return;
      this.sel = null;
      this.applied = null;
    });
  }

  // ───────────────────────────── selection (model range) ─────────────────────────────

  /** Seam that applies a DOM selection; tests inject a recorder. */
  setSelection: (anchorEl: Node, anchorOffset: number, focusEl: Node, focusOffset: number) => void = (a, ao, f, fo) =>
    window.getSelection()?.setBaseAndExtent(a, ao, f, fo);

  private sel: SelRange | null = null;
  /** True when the user's anchor is the end of the normalised range (bottom-to-top selection). */
  private rev = false;
  /** This view was last used and keyboard focus is still in it (or nowhere in particular). */
  private get active() {
    if (current !== this) return false;
    const f = document.activeElement;
    return !f || f === document.body || this.el.contains(f);
  }
  /** The primary button went down in the rows and has not been released. */
  private held = false;
  /** Endpoints of the last DOM selection we applied; its selectionchange echo must not shrink the model. */
  private applied: SelRange | null = null;

  /** The selection as a normalised model range, or null. */
  get selection(): SelRange | null {
    return this.sel;
  }

  /** Sets the model range; the DOM selection is restored on the next render. */
  setRange(r: SelRange | null) {
    this.sel = r ? normalize(r) : null;
    this.rev = false;
    this.applied = null;
    this.schedule();
  }

  /** Selects the whole file as a model range. */
  selectAll() {
    this.setRange(allRange(this.lines));
  }

  /** Text of the model selection ("" when none), never including decorations. */
  selectedText(): string {
    return this.sel ? selectionText(this.lines, this.sel) : "";
  }

  private rowTx(n: number): HTMLElement | null {
    for (const row of this.linesEl.querySelectorAll<HTMLElement>(".ln")) {
      if (Number(row.dataset.n) === n) return row.querySelector<HTMLElement>(".tx");
    }
    return null;
  }

  /** Re-applies the model range to the freshly rendered rows. */
  private restoreSelection() {
    if (!this.sel) return;
    if (this.held) {
      // Never fight the browser mid-drag unless the render destroyed the anchor (the selection then
      // collapses onto a container such as .code-lines, which is not inside any row's text).
      const an = window.getSelection?.()?.anchorNode;
      const el = an ? (an.nodeType === 3 ? an.parentElement : (an as HTMLElement)) : null;
      const tx = el?.closest?.<HTMLElement>(".tx");
      if (tx && this.linesEl.contains(tx)) return;
    }
    const last = Math.min(this.window.last, this.lines.length) - 1;
    const plan = restorePlan(this.sel, this.window.first, last, (l) => Math.min(this.lines[l]?.length ?? 0, MAX_RENDER_COLS));
    if (!plan) return;
    const a = this.rowTx(plan.anchor.line);
    const f = this.rowTx(plan.focus.line);
    if (!a || !f) return;
    const [sn, so] = locate(a, plan.anchor.offset);
    const [en, eo] = locate(f, plan.focus.offset);
    // anchor/focus keep the user's direction; `applied` is stored in the same anchor -> focus order
    const [an, ao, fn, fo] = this.rev ? [en, eo, sn, so] : [sn, so, en, eo];
    const [ap, fp] = this.rev ? [plan.focus, plan.anchor] : [plan.anchor, plan.focus];
    this.applied = { start: { line: ap.line, col: ap.offset }, end: { line: fp.line, col: fp.offset } };
    this.setSelection(an, ao, fn, fo);
  }

  /** Mirrors a user (mouse/keyboard) DOM selection inside the rows into the model range. */
  private readDomSelection() {
    const ds = window.getSelection?.();
    if (!ds || ds.rangeCount === 0 || !ds.anchorNode || !ds.focusNode) return;
    if (ds.isCollapsed) {
      // The user collapsed the selection inside the rows (arrow key, click): the model range is stale.
      // Not while a render is pending, which is about to re-apply it.
      if (this.sel && !this.frame && !this.held && this.linesEl.contains(ds.anchorNode)) {
        this.sel = null;
        this.applied = null;
      }
      return;
    }
    const pos = (node: Node, off: number) => {
      const el = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
      const row = el?.closest<HTMLElement>(".ln");
      const tx = row?.querySelector<HTMLElement>(".tx");
      if (!row || !tx || !this.linesEl.contains(row)) return null;
      return { line: Number(row.dataset.n), col: Math.min(colOf(tx, node, off), this.lines[Number(row.dataset.n)]?.length ?? 0) };
    };
    const a = pos(ds.anchorNode, ds.anchorOffset);
    const f = pos(ds.focusNode, ds.focusOffset);
    if (!a || !f) {
      // An endpoint outside the whole view (not just outside the rows) means a selection made elsewhere.
      if ((!a && !this.el.contains(ds.anchorNode)) || (!f && !this.el.contains(ds.focusNode))) {
        this.sel = null;
        this.applied = null;
      }
      return;
    }
    const ap = this.applied;
    if (ap && a.line === ap.start.line && a.col === ap.start.col && f.line === ap.end.line && f.col === ap.end.col) return;
    this.applied = null;
    this.rev = f.line < a.line || (f.line === a.line && f.col < a.col);
    this.sel = normalize({ start: a, end: f });
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
    this.sr = null;
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
    this.syncBlame();
  }

  private blameVisible(i: number): boolean {
    return !!this.blame && this.blame.line === i && !this.held && !this.sel && window.getSelection?.()?.isCollapsed !== false;
  }

  private rowEl(i: number): HTMLElement | null {
    return this.linesEl.querySelector<HTMLElement>?.(`.ln[data-n="${i}"]`) ?? null;
  }

  /** Line whose row currently carries the .blame span (-1 = none). */
  private shownBlame = -1;

  /** Patches the single .blame span in place; rebuilding rows would break a drag-selection. */
  private syncBlame() {
    const want = this.blame && this.blameVisible(this.blame.line) ? this.blame.line : -1;
    if (this.shownBlame >= 0) this.rowEl(this.shownBlame)?.querySelector?.(".blame")?.remove();
    this.shownBlame = -1;
    if (want < 0) return;
    const row = this.rowEl(want);
    if (!row) return;
    row.insertAdjacentHTML("beforeend", `<span class="blame">${this.blame!.html}</span>`);
    this.shownBlame = want;
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
    // A click on a gutter marker toggles the peek itself.
    const off = dismissable(box, () => this.closePeek(), { keep: (t) => !!t.classList?.contains("g") });
    box.addEventListener("peek-close", off);
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
      const blame = this.blameVisible(i) ? `<span class="blame">${this.blame!.html}</span>` : "";
      html += `<div class="${cls}" data-n="${i}"${style}><span class="g">${i + 1}</span><span class="tx">${this.lineHtml(i)}</span>${blame}</div>`;
    }
    this.linesEl.style.transform = `translateY(${first * this.lh}px)`;
    this.linesEl.innerHTML = html;
    const bl = this.blame?.line ?? -1;
    this.shownBlame = bl >= first && bl < last && this.blameVisible(bl) ? bl : -1;
    this.restoreSelection();
  }

  private lineHtml(i: number): string {
    const findMarks = !!(this.query && this.mLine.length);
    const hasMarks = findMarks || this.sr?.line === i;
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
      const ranges: MarkRange[] = [];
      if (findMarks) {
        let k = lowerBound(this.mLine, i);
        while (k < this.mLine.length && this.mLine[k] === i) {
          ranges.push({ start: this.mStart[k]!, end: this.mEnd[k]!, cur: k === this.mCur });
          k++;
        }
      }
      if (this.sr?.line === i) ranges.push({ start: this.sr.start, end: this.sr.end, cur: true });
      mark = markRanges(n, ranges);
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
    const old = this.activeLine;
    this.activeLine = n;
    this.onActiveLine(n);
    if (old !== n) {
      if (old >= 0) this.rowEl(old)?.classList?.remove?.("active");
      this.rowEl(n)?.classList?.add?.("active");
    }
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

  /** Marks 0-based `line` columns [start, end) as the current match and scrolls it into view. */
  showRange(line: number, start: number, end: number) {
    line = Math.max(0, Math.min(this.lines.length - 1, line));
    start = Math.min(start, MAX_RENDER_COLS);
    end = Math.min(end, MAX_RENDER_COLS);
    this.sr = { line, start, end };
    this.cache.clear();
    this.revealLine(line);
    const s = this.scroller;
    s.scrollLeft = revealCol(s.scrollLeft, s.clientWidth, this.gutterW, this.charW, start);
    this.schedule();
  }

  openFind() {
    if (this.sr) {
      this.sr = null;
      this.cache.clear();
    }
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
    const s = this.scroller;
    s.scrollLeft = revealCol(s.scrollLeft, s.clientWidth, this.gutterW, this.charW, this.mStart[this.mCur]!);
    this.schedule();
  }
}

/** True for targets that own Cmd+A / Cmd+C themselves (inputs, textareas such as the terminal's, editable hosts). */
function isEditable(t: EventTarget | null): boolean {
  const e = t as HTMLElement | null;
  const tag = e?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!e?.isContentEditable;
}

/** Text node and offset for a text offset inside a row's text element (the truncation label is skipped). */
function locate(tx: Node, off: number): [Node, number] {
  let left = off;
  let lastText: Text | null = null;
  const walk = (n: Node): [Node, number] | null => {
    for (const c of Array.from(n.childNodes ?? [])) {
      if (c.nodeType === 3) {
        lastText = c as Text;
        const len = (c as Text).data.length;
        if (left <= len) return [c, left];
        left -= len;
      } else if (c.nodeType === 1 && !(c as HTMLElement).classList.contains("trunc")) {
        const r = walk(c);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(tx) ?? (lastText ? [lastText, (lastText as Text).data.length] : [tx, 0]);
}

/** Text offset of (node, off) within a row's text element. */
function colOf(tx: Node, node: Node, off: number): number {
  let n = 0;
  let done = false;
  const walk = (p: Node) => {
    for (const c of Array.from(p.childNodes)) {
      if (done) return;
      if (c === node) {
        if (c.nodeType === 3) n += off;
        else for (let i = 0; i < off; i++) n += c.childNodes[i]?.textContent?.length ?? 0;
        done = true;
        return;
      }
      if (c.nodeType === 3) n += (c as Text).data.length;
      else if (c.contains(node)) walk(c);
      else n += c.textContent?.length ?? 0;
    }
  };
  if (node === tx) for (let i = 0; i < off; i++) n += tx.childNodes[i]?.textContent?.length ?? 0;
  else walk(tx);
  return n;
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
