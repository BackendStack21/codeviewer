import { api } from "./api.ts";
import { fileIcon, icons } from "./icons.ts";
import { esc, h } from "./util.ts";

export interface Command {
  id: string;
  label: string;
  keys?: string;
  run(): void;
}

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
        found = k;
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

/** ⌘P quick open, ">" commands, ":" go to line. */
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
  /** When set, the palette lists these entries instead of all files (e.g. git changes). */
  private custom: { path: string; badge: string; cls: string; detail: string }[] | null = null;
  onGoToLine: (line: number) => void = () => {};

  constructor() {
    this.input = h("input", { class: "palette-input", spellcheck: "false", "aria-label": "Search files or commands" });
    this.list = h("div", { class: "palette-list", role: "listbox" });
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

  /** Shows a filterable list of specific files (e.g. changed files), each with a badge. */
  openList(items: { path: string; badge: string; cls: string; detail: string }[], placeholder: string) {
    this.custom = items;
    this.input.placeholder = placeholder;
    this.open();
  }

  open(prefix = "") {
    this.prevFocus = document.activeElement;
    this.el.hidden = false;
    this.input.value = prefix;
    this.input.focus();
    this.update();
    if (this.stale) void this.ensureFiles().then(() => !this.el.hidden && this.update());
  }

  close() {
    this.el.hidden = true;
    this.custom = null;
    this.input.placeholder = "";
    (this.prevFocus as HTMLElement | null)?.focus?.();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  private update() {
    const v = this.input.value;
    this.items = [];
    if (this.custom) {
      const q = v.trim();
      const rows = this.custom
        .map((it) => ({ it, m: q ? scorePath(q, it.path) : { score: 0, pos: [] } }))
        .filter((x): x is { it: (typeof x)["it"]; m: Match } => !!x.m);
      if (q) rows.sort((a, b) => b.m.score - a.m.score);
      for (const { it, m } of rows) {
        const slash = it.path.lastIndexOf("/", it.path.length - 2) + 1;
        const base = it.path.slice(slash);
        const html = this.row(
          fileIcon(base),
          `<span class="${it.cls}">${highlight(base, m.pos.filter((i) => i >= slash).map((i) => i - slash))}</span>`,
          `${esc(it.detail)} · ${highlight(it.path.slice(0, Math.max(0, slash - 1)), m.pos.filter((i) => i < slash))}`,
        ).replace("</div>", `<span class="gbadge ${it.cls}">${it.badge}</span></div>`);
        this.items.push({ label: it.path, html, run: () => this.onOpenFile(it.path.replace(/\/$/, "")) });
      }
      if (!this.items.length) {
        this.list.innerHTML = `<div class="pal-empty">${this.custom.length ? "No matching changes" : "No changes: the working tree is clean"}</div>`;
        return;
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
      if (!this.items.length) {
        const msg = this.stale && this.loading ? "Indexing files…" : q ? "No matching files" : "No files";
        this.list.innerHTML = `<div class="pal-empty">${msg}</div>`;
        return;
      }
    }
    this.sel = 0;
    this.list.innerHTML = this.items.map((it, i) => it.html.replace("<div class=\"pal-item\"", `<div class="pal-item${i === 0 ? " sel" : ""}" data-i="${i}"`)).join("");
  }

  private row(icon: string, main: string, detail: string, keys?: string): string {
    return `<div class="pal-item" role="option">${icon}<span class="pal-main">${main}</span><span class="pal-detail">${detail}</span>${keys ? `<kbd>${esc(keys)}</kbd>` : ""}</div>`;
  }

  private move(d: number) {
    if (!this.items.length) return;
    this.sel = (this.sel + d + this.items.length) % this.items.length;
    this.list.querySelectorAll(".pal-item").forEach((el, i) => el.classList.toggle("sel", i === this.sel));
    this.list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }

  private accept(i: number) {
    const it = this.items[i];
    if (!it) return;
    this.el.hidden = true;
    this.custom = null;
    this.input.placeholder = "";
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
