import { api } from "./api.ts";
import { fileIcon, icons } from "./icons.ts";
import { esc, h } from "./util.ts";

export interface Command {
  id: string;
  label: string;
  keys?: string;
  run(): void;
}

/** A row of a list the palette picks from ("@" symbols, file history). */
export interface PickItem {
  label: string;
  /** Plain text after the label (a line number, an author and date). */
  detail?: string;
  /** Icon markup (trusted: from icons.ts). */
  icon?: string;
  /** Indentation steps (an outline's nesting). */
  indent?: number;
  run(): void;
}

/** Rows rendered at most in a picked list; typing narrows it. */
const PICK_MAX = 300;

interface Match {
  score: number;
  pos: number[];
}

const BOUNDARY = /[/\\_\-. ]/;

/** Subsequence match with bonuses for word starts, contiguity and basename hits. */
export function fuzzy(q: string, s: string, base = 0, sl = s.toLowerCase(), ql = q.toLowerCase()): Match | null {
  const pos: number[] = [];
  let score = 0;
  let si = base;
  let prev = -2;
  for (let qi = 0; qi < ql.length; qi++) {
    const c = ql[qi]!;
    if (c === " ") continue;
    // Prefer an occurrence at a word boundary within reach, else the first one.
    let found = sl.indexOf(c, si);
    if (found < 0) return null;
    for (let k = found; k >= 0 && k < sl.length && k < found + 24; k = sl.indexOf(c, k + 1)) {
      if (k === 0 || BOUNDARY.test(s[k - 1]!) || (s[k]! !== sl[k] && s[k - 1] === sl[k - 1])) {
        if (k === prev + 1) break;
        // Jump only if the rest of the query still fits after it ("sto" in "stop<T>" keeps the "t" of "stop").
        if (k === found || subsequence(ql, qi + 1, sl, k + 1)) found = k;
        break;
      }
    }
    if (found === prev + 1) score += 6;
    else if (found === 0 || BOUNDARY.test(s[found - 1]!)) score += 8;
    else if (s[found] !== sl[found]) score += 5;
    else score += 1;
    if (q[qi] === s[found]) score += 0.5;
    pos.push(found);
    prev = found;
    si = found + 1;
  }
  score -= s.length * 0.02;
  return { score, pos };
}

/** True when `ql` from `qi` on (spaces skipped) is a subsequence of `sl` from `si` on. */
function subsequence(ql: string, qi: number, sl: string, si: number): boolean {
  for (; qi < ql.length; qi++) {
    if (ql[qi] === " ") continue;
    si = sl.indexOf(ql[qi]!, si);
    if (si < 0) return false;
    si++;
  }
  return true;
}

export function scorePath(q: string, path: string, lower = path.toLowerCase(), ql = q.toLowerCase()): Match | null {
  const slash = path.lastIndexOf("/") + 1;
  const inBase = fuzzy(q, path, slash, lower, ql);
  if (inBase) return { score: inBase.score + 30 + (path.length - slash === q.length ? 20 : 0), pos: inBase.pos };
  return fuzzy(q, path, 0, lower, ql);
}

const TOP = 80;

/**
 * Best TOP matches of `q` over `files` (with precomputed lowercase `lower`). When `prev`
 * holds the matches of a prefix of `q`, only those are re-scored: a longer query can only
 * match a subset. Returns all matching indices too, for the next keystroke.
 */
export function searchPaths(q: string, files: string[], lower: string[], prev: Int32Array | null) {
  const ql = q.toLowerCase();
  const hits: number[] = [];
  const best: { p: string; m: Match }[] = []; // ascending by score, at most TOP
  const n = prev ? prev.length : files.length;
  for (let k = 0; k < n; k++) {
    const i = prev ? prev[k]! : k;
    const m = scorePath(q, files[i]!, lower[i]!, ql);
    if (!m) continue;
    hits.push(i);
    if (best.length === TOP && m.score <= best[0]!.m.score) continue;
    let lo = 0;
    let hi = best.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (best[mid]!.m.score < m.score) lo = mid + 1;
      else hi = mid;
    }
    best.splice(lo, 0, { p: files[i]!, m });
    if (best.length > TOP) best.shift();
  }
  best.reverse();
  best.sort((a, b) => b.m.score - a.m.score || a.p.length - b.p.length);
  return { best, hits: Int32Array.from(hits) };
}

/** ⌘P quick open, ">" commands, ":" go to line, "@" symbols of the active file, and picked lists. */
export class Palette {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private files: string[] = [];
  private lower: string[] = [];
  private lastQ = "";
  private lastHits: Int32Array | null = null;
  private stale = true;
  private loading: Promise<void> | null = null;
  private items: { label: string; detail?: string; html: string; run: () => void }[] = [];
  private sel = 0;
  private prevFocus: Element | null = null;
  recent: string[] = [];
  commands: Command[] = [];
  onOpenFile: (path: string, line?: number) => void = () => {};
  onGoToLine: (line: number) => void = () => {};
  /** "@" mode: the active file's symbols, or a message when it has none. */
  symbols: () => PickItem[] | string = () => "Open a file to see its symbols";
  /** A list shown by `pick` until the palette closes. */
  private picked: { items: PickItem[]; empty: string } | null = null;
  /** "@" mode's symbols, computed once per opening (a large file is not rescanned per keystroke). */
  private syms: PickItem[] | string | null = null;

  constructor() {
    this.input = h("input", {
      class: "palette-input", spellcheck: "false", "aria-label": "Search files or commands",
      role: "combobox", "aria-expanded": "false", "aria-haspopup": "listbox", "aria-controls": "pal-list", "aria-autocomplete": "list",
    });
    this.list = h("div", { class: "palette-list", role: "listbox", id: "pal-list" });
    const box = h("div", { class: "palette" }, h("div", { class: "palette-field" }, h("span", { html: icons.search }), this.input), this.list);
    this.el = h("div", { class: "overlay", hidden: true }, box);
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close();
    });
    this.input.addEventListener("input", () => this.update());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) this.move(1);
      else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) this.move(-1);
      else if (e.key === "Enter") this.accept(this.sel);
      else if (e.key === "Escape") this.close();
      else return;
      e.preventDefault();
    });
    this.list.addEventListener("mousedown", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".pal-item");
      if (row) {
        e.preventDefault();
        this.accept(Number(row.dataset.i));
      }
    });
  }

  invalidate() {
    this.stale = true;
  }

  private async ensureFiles() {
    if (!this.stale) return;
    this.loading ??= api
      .index()
      .then((f) => {
        this.files = f;
        this.lower = f.map((p) => p.toLowerCase());
        this.lastQ = "";
        this.lastHits = null;
        this.stale = false;
      })
      .finally(() => (this.loading = null));
    await this.loading;
  }

  open(prefix = "") {
    this.picked = null;
    this.input.removeAttribute("placeholder");
    this.show(prefix);
  }

  /** Shows `items` to filter and pick from; `empty` is the message for an empty list. */
  pick(items: PickItem[], placeholder: string, empty = "Nothing to show") {
    this.picked = { items, empty };
    this.input.setAttribute("placeholder", placeholder);
    this.show("");
  }

  private show(prefix: string) {
    this.syms = null;
    if (this.el.hidden) this.prevFocus = document.activeElement;
    this.el.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.input.value = prefix;
    this.input.focus();
    this.update();
    if (this.stale) void this.ensureFiles().then(() => !this.el.hidden && this.update());
  }

  close() {
    this.picked = null;
    this.el.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    (this.prevFocus as HTMLElement | null)?.focus?.();
  }

  /** Tells assistive tech which option is current. */
  private syncActive() {
    if (this.items.length) this.input.setAttribute("aria-activedescendant", `pal-${this.sel}`);
    else this.input.removeAttribute("aria-activedescendant");
  }

  get isOpen() {
    return !this.el.hidden;
  }

  private update() {
    const v = this.input.value;
    this.items = [];
    if (this.picked || v.startsWith("@")) {
      const src = this.picked ? this.picked.items : (this.syms ??= this.symbols());
      const q = (this.picked ? v : v.slice(1)).trim();
      if (typeof src === "string" || !src.length) return this.empty(typeof src === "string" ? src : (this.picked?.empty ?? "No symbols in this file"));
      // Without a query the list keeps its own order (an outline, newest commits first).
      const scored: { it: PickItem; m: Match }[] = [];
      for (const it of src) {
        const m = q ? fuzzy(q, it.label) : { score: 0, pos: [] };
        if (m) scored.push({ it, m });
      }
      if (q) scored.sort((a, b) => b.m.score - a.m.score);
      if (!scored.length) return this.empty("No matches");
      for (const { it, m } of scored.slice(0, PICK_MAX)) {
        const pad = !q && it.indent ? `<span class="pal-indent" style="width:${Math.min(it.indent, 8) * 14}px"></span>` : "";
        this.items.push({ label: it.label, html: this.row(pad + (it.icon ?? icons.code), highlight(it.label, m.pos), esc(it.detail ?? ""), undefined, "pal-detail plain"), run: it.run });
      }
    } else if (v.startsWith(">")) {
      const q = v.slice(1).trim();
      const scored: { c: Command; m: Match }[] = [];
      for (const c of this.commands) {
        const m = q ? fuzzy(q, c.label) : { score: 0, pos: [] };
        if (m) scored.push({ c, m });
      }
      if (q) scored.sort((a, b) => b.m.score - a.m.score);
      for (const { c, m } of scored) this.items.push({ label: c.label, html: this.row(icons.code, highlight(c.label, m.pos), "", c.keys), run: c.run });
    } else if (v.startsWith(":")) {
      const n = parseInt(v.slice(1), 10);
      this.items.push({
        label: "line",
        html: this.row(icons.code, Number.isFinite(n) ? `Go to line <b>${n}</b>` : "Type a line number", ""),
        run: () => Number.isFinite(n) && this.onGoToLine(n),
      });
    } else {
      // "path:line" opens at a line.
      const lm = /^(.*?)(?::(\d+))?$/.exec(v.trim())!;
      const q = lm[1]!.replace(/\s+/g, "");
      const line = lm[2] ? Number(lm[2]) : undefined;
      let scored: { p: string; m: Match }[];
      if (!q) {
        const known = this.files.length ? new Set(this.files) : null;
        const recent = this.recent.filter((p) => !known || known.has(p));
        scored = recent.map((p) => ({ p, m: { score: 0, pos: [] } }));
        if (scored.length < 30) for (const p of this.files.slice(0, 30 - scored.length)) if (!recent.includes(p)) scored.push({ p, m: { score: 0, pos: [] } });
      } else {
        const narrow = this.lastHits && this.lastQ && q.startsWith(this.lastQ) ? this.lastHits : null;
        const r = searchPaths(q, this.files, this.lower, narrow);
        scored = r.best;
        this.lastQ = q;
        this.lastHits = r.hits;
      }
      for (const { p, m } of scored) {
        const slash = p.lastIndexOf("/") + 1;
        const base = p.slice(slash);
        const basePos = m.pos.filter((i) => i >= slash).map((i) => i - slash);
        const dirPos = m.pos.filter((i) => i < slash);
        this.items.push({
          label: p,
          html: this.row(fileIcon(base), highlight(base, basePos), highlight(p.slice(0, Math.max(0, slash - 1)), dirPos)),
          run: () => this.onOpenFile(p, line),
        });
      }
      if (!this.items.length) return this.empty(this.stale && this.loading ? "Indexing files…" : q ? "No matching files" : "No files");
    }
    this.sel = 0;
    this.list.innerHTML = this.items
      .map((it, i) => it.html.replace("<div class=\"pal-item\"", `<div class="pal-item${i === 0 ? " sel" : ""}" data-i="${i}" id="pal-${i}" aria-selected="${i === 0}"`))
      .join("");
    this.syncActive();
  }

  private empty(msg: string) {
    this.items = [];
    this.list.innerHTML = `<div class="pal-empty">${esc(msg)}</div>`;
    this.syncActive();
  }

  private row(icon: string, main: string, detail: string, keys?: string, detailClass = "pal-detail"): string {
    return `<div class="pal-item" role="option">${icon}<span class="pal-main">${main}</span><span class="${detailClass}">${detail}</span>${keys ? `<kbd>${esc(keys)}</kbd>` : ""}</div>`;
  }

  private move(d: number) {
    if (!this.items.length) return;
    this.sel = (this.sel + d + this.items.length) % this.items.length;
    this.list.querySelectorAll(".pal-item").forEach((el, i) => {
      el.classList.toggle("sel", i === this.sel);
      el.setAttribute("aria-selected", String(i === this.sel));
    });
    this.syncActive();
    this.list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }

  private accept(i: number) {
    const it = this.items[i];
    if (!it) return;
    this.el.hidden = true;
    this.picked = null;
    it.run();
  }
}

function highlight(s: string, pos: number[]): string {
  if (!pos.length) return esc(s);
  const set = new Set(pos);
  let out = "";
  for (let i = 0; i < s.length; i++) out += set.has(i) ? `<b>${esc(s[i]!)}</b>` : esc(s[i]!);
  return out;
}
