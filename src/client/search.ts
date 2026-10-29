import { api, type SearchEvent, type SearchMatch } from "./api.ts";
import { esc, h, showHidden } from "./util.ts";

export type { SearchEvent };

export interface SearchViewOptions {
  /** Live-search debounce in ms (default 250); 0 runs synchronously on input. */
  debounce?: number;
}

interface Group {
  path: string;
  matches: SearchMatch[];
  more: number;
  collapsed: boolean;
}

type Opt = "case" | "word" | "regex" | "ignored";

/** Shows control characters and bidi overrides as visible escapes, then HTML-escapes. */
function safe(s: string): string {
  return esc(showHidden(s));
}

/** An include glob for everything under `dir`: Bun.Glob metacharacters, commas (the list separator) and whitespace (trimmed from list entries) backslash-escaped, so the scope is literal. */
export function folderGlob(dir: string): string {
  return `${dir.replace(/[\\*?[\]{}!,\s]/g, "\\$&")}/**`;
}

/** Longest include list the server accepts (src/server/search.ts MAX_GLOB_CHARS). */
const MAX_INCLUDE = 1024;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Project-wide content search panel: query, option toggles, results grouped by file. */
export class SearchView {
  readonly el: HTMLElement;
  onOpen: (path: string, line: number, col: number, len: number) => void = () => {};
  /** Makes the view visible; searchIn calls it once the scope is set, before searching. */
  onReveal: () => void = () => {};
  private input: HTMLInputElement;
  private include: HTMLInputElement;
  private exclude: HTMLInputElement;
  private results: HTMLElement;
  private progress: HTMLElement;
  private toggles = new Map<Opt, HTMLElement>();
  private on: Record<Opt, boolean> = { case: false, word: false, regex: false, ignored: false };
  private debounce: number;
  private timer = 0;
  private progressTimer = 0;
  private renderTimer = 0;
  private gen = 0;
  private ac: AbortController | null = null;
  private groups: Group[] = [];
  private flat: { path: string; m: SearchMatch; g: number }[] = [];
  private done: Extract<SearchEvent, { t: "done" }> | null = null;
  private error: string | null = null;
  private running = false;
  private ranQ = "";
  private started = false;
  private sel = -1;
  private stale = false;
  private pending = new Set<string>();
  private staleBar: HTMLElement;

  constructor(opts: SearchViewOptions = {}) {
    this.debounce = opts.debounce ?? 250;
    this.input = h("input", { class: "sv-query", spellcheck: "false", placeholder: "Search", "aria-label": "Search in files" });
    this.include = h("input", { class: "sv-include", spellcheck: "false", placeholder: "files to include", "aria-label": "Files to include" });
    this.exclude = h("input", { class: "sv-exclude", spellcheck: "false", placeholder: "files to exclude", "aria-label": "Files to exclude" });
    this.results = h("div", { class: "sv-results", role: "listbox", tabindex: "0" });
    this.progress = h("div", { class: "sv-progress", hidden: true });
    const refresh = h("button", { class: "sv-refresh", type: "button" }, "Refresh");
    refresh.addEventListener("click", () => void this.run());
    this.staleBar = h("div", { class: "sv-stale", hidden: true }, h("span", null, "Results may be out of date"), refresh);
    const tog = (opt: Opt, label: string, title: string, cls = "") => {
      const b = h("button", { class: `sv-toggle ${cls}`.trim(), "data-opt": opt, "aria-pressed": "false", title, type: "button" }, label);
      b.addEventListener("click", () => {
        this.on[opt] = !this.on[opt];
        b.setAttribute("aria-pressed", String(this.on[opt]));
        this.schedule(true);
      });
      this.toggles.set(opt, b);
      return b;
    };
    this.el = h(
      "div",
      { class: "search-view" },
      h(
        "div",
        { class: "sv-top" },
        h("div", { class: "sv-field" }, this.input, tog("case", "Aa", "Match case"), tog("word", "ab", "Whole word"), tog("regex", ".*", "Regular expression")),
        this.include,
        this.exclude,
        tog("ignored", "Include ignored files", "Also search files excluded by .gitignore", "sv-wide"),
      ),
      this.staleBar,
      this.progress,
      this.results,
    );
    this.input.addEventListener("input", () => this.schedule(false));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.input.value) {
        e.preventDefault();
        this.run();
      } else if (e.key === "Escape" && this.input.value) {
        e.preventDefault();
        this.input.value = "";
        this.reset();
      }
    });
    this.results.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.move(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = this.visible(this.sel) ? this.flat[this.sel] : undefined;
        if (hit) this.onOpen(hit.path, hit.m.line, hit.m.col, hit.m.len);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.input.focus();
      }
    });
    this.include.addEventListener("input", () => this.schedule(false));
    this.exclude.addEventListener("input", () => this.schedule(false));
    this.results.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const row = t.closest<HTMLElement>(".sv-row");
      if (row) {
        const hit = this.flat[Number(row.dataset.i)];
        if (hit) this.onOpen(hit.path, hit.m.line, hit.m.col, hit.m.len);
        return;
      }
      const head = t.closest<HTMLElement>(".sv-file");
      const g = head ? this.groups[Number(head.dataset.f)] : null;
      if (g) {
        g.collapsed = !g.collapsed;
        if (g.collapsed && this.flat[this.sel]?.g === Number(head!.dataset.f)) this.sel = this.nearestVisible(this.sel);
        this.render();
      }
    });
    this.render();
  }

  /** Index into the flat result list of the selected row, -1 when none. */
  get selected(): number {
    return this.sel;
  }

  /** Moves the selection by one row without opening it (clamped at both ends). */
  move(dir: 1 | -1): void {
    const vis: number[] = [];
    this.flat.forEach((_, i) => this.visible(i) && vis.push(i));
    if (!vis.length) return;
    const at = vis.indexOf(this.sel);
    this.sel = at < 0 ? (dir === 1 ? vis[0]! : vis[vis.length - 1]!) : vis[Math.max(0, Math.min(vis.length - 1, at + dir))]!;
    this.render();
    this.results.querySelector(".sv-row.sel")?.scrollIntoView?.({ block: "nearest" });
  }

  private visible(i: number): boolean {
    const f = this.flat[i];
    return !!f && !this.groups[f.g]!.collapsed;
  }

  /** The visible row closest to `i` (earlier one on a tie), or -1 when no row is visible. */
  private nearestVisible(i: number): number {
    let best = -1;
    for (let k = 0; k < this.flat.length; k++) {
      if (!this.visible(k)) continue;
      if (best < 0 || Math.abs(k - i) < Math.abs(best - i)) best = k;
    }
    return best;
  }

  /** Selects the next/previous result (wrapping) and opens it; false when there are no results. */
  step(dir: 1 | -1): boolean {
    const n = this.flat.length;
    if (!n) return false;
    this.sel = this.sel < 0 ? (dir === 1 ? 0 : n - 1) : (this.sel + dir + n) % n;
    this.render();
    this.results.querySelector(".sv-row.sel")?.scrollIntoView?.({ block: "nearest" });
    const grp = this.groups[this.flat[this.sel]!.g]!;
    if (grp.collapsed) {
      grp.collapsed = false;
      this.render();
    }
    const hit = this.flat[this.sel]!;
    this.onOpen(hit.path, hit.m.line, hit.m.col, hit.m.len);
    return true;
  }

  /** A file changed on disk: when it is in the results (or `many` changed), offer a Refresh. */
  markStale(paths: string[], many = false): void {
    if (!this.started || this.error) return;
    if (many || this.groups.some((g) => paths.includes(g.path))) return this.showStale();
    // Still streaming: the path may arrive later in this stream, so remember it until the end.
    if (this.running) for (const p of paths) this.pending.add(p);
  }

  private showStale() {
    this.stale = true;
    this.staleBar.hidden = false;
  }

  /** Call when the view becomes visible: refreshes once if results went stale while it was hidden. */
  onShown(): void {
    if (this.stale) void this.run();
  }

  private clearStale() {
    this.pending.clear();
    this.stale = false;
    this.staleBar.hidden = true;
  }

  /** Scopes the search to one folder (via the include field) and re-runs any current query. */
  searchIn(dir: string, ignored = false): void {
    const glob = folderGlob(dir);
    this.include.value = glob;
    if (ignored && !this.on.ignored) {
      // A git-ignored folder has no results unless ignored files are searched too.
      this.on.ignored = true;
      this.toggles.get("ignored")?.setAttribute("aria-pressed", "true");
    }
    // The search below replaces stale results, so revealing the view must not start its own.
    this.clearStale();
    this.onReveal();
    this.focus();
    if (glob.length > MAX_INCLUDE) {
      this.cancel();
      this.started = true;
      this.groups = [];
      this.done = null;
      this.error = "Folder path is too long to search in as a folder";
      this.input.classList.remove("invalid");
      return this.render();
    }
    if (this.eligible()) this.schedule(true);
  }

  focus() {
    this.input.focus();
    (this.input as unknown as { select?: () => void }).select?.();
  }

  private eligible() {
    return this.input.value.length >= (this.on.regex ? 1 : 2);
  }

  /** Input or option change: reset on empty, otherwise search now or after the debounce. */
  private schedule(now: boolean) {
    clearTimeout(this.timer);
    if (!this.input.value) return this.reset();
    if (!this.eligible()) return this.reset();
    if (now || this.debounce <= 0) this.run();
    else this.timer = window.setTimeout(() => this.run(), this.debounce);
  }

  private cancel() {
    this.clearStale();
    clearTimeout(this.timer);
    clearTimeout(this.progressTimer);
    clearTimeout(this.renderTimer);
    this.gen++;
    this.ac?.abort();
    this.ac = null;
    this.running = false;
    this.progress.hidden = true;
  }

  private reset() {
    this.cancel();
    this.started = false;
    this.sel = -1;
    this.groups = [];
    this.done = null;
    this.error = null;
    this.input.classList.remove("invalid");
    this.render();
  }

  private async run() {
    clearTimeout(this.timer);
    const q = this.input.value;
    if (!q) return this.reset();
    this.cancel();
    const g = this.gen;
    const ac = (this.ac = new AbortController());
    this.started = true;
    this.sel = -1;
    this.groups = [];
    this.done = null;
    this.error = null;
    this.running = true;
    this.ranQ = q;
    this.input.classList.remove("invalid");
    this.progressTimer = window.setTimeout(() => {
      if (g === this.gen && this.running) this.progress.hidden = false;
    }, 150);
    this.render();
    try {
      const params = {
        q,
        case: this.on.case,
        word: this.on.word,
        regex: this.on.regex,
        include: this.include.value.trim(),
        exclude: this.exclude.value.trim(),
        ignored: this.on.ignored,
      };
      for await (const e of api.search(params, ac.signal)) {
        if (g !== this.gen) break;
        if (e.t === "done") this.done = e;
        else this.groups.push({ path: e.path, matches: e.matches, more: e.more ?? 0, collapsed: false });
        if (e.t === "done" || this.groups.length < 50) this.render();
        else if (!this.renderTimer) this.renderTimer = window.setTimeout(() => ((this.renderTimer = 0), this.render()), 100);
      }
    } catch (e) {
      if (g === this.gen) {
        this.error = e instanceof TypeError ? "Search failed" : e instanceof Error ? e.message : "Search failed";
        if (!(e instanceof TypeError)) this.input.classList.add("invalid");
      }
    } finally {
      if (g === this.gen) {
        this.running = false;
        clearTimeout(this.progressTimer);
        clearTimeout(this.renderTimer);
        this.renderTimer = 0;
        this.progress.hidden = true;
        if (!this.error && this.groups.some((g) => this.pending.has(g.path))) this.showStale();
        this.pending.clear();
        this.render();
      }
    }
  }

  private render() {
    this.flat = [];
    if (this.error) {
      this.results.innerHTML = `<div class="sv-msg sv-error">${safe(this.error)}</div>`;
      return;
    }
    if (!this.started) {
      this.results.innerHTML = `<div class="sv-msg">Type to search in files</div>`;
      return;
    }
    const d = this.done;
    const skipped = d && d.skipped ? `<div class="sv-note">${plural(d.skipped, "binary/large file", "binary/large files")} skipped</div>` : "";
    if (!this.groups.length) {
      this.results.innerHTML = this.running
        ? `<div class="sv-msg">Searching…</div>`
        : d
          ? `<div class="sv-msg">No results for "${safe(this.ranQ)}"</div>${skipped}`
          : `<div class="sv-msg">Search ended early - no results</div>`;
      return;
    }
    let total = 0;
    let html = "";
    this.groups.forEach((g, gi) => {
      const slash = g.path.lastIndexOf("/");
      const dir = slash > 0 ? `<span class="sv-dir">${safe(g.path.slice(0, slash))}</span>` : "";
      const count = g.matches.length + g.more;
      total += count;
      html += `<div class="sv-file${g.collapsed ? " collapsed" : ""}" data-f="${gi}" aria-expanded="${!g.collapsed}"><span class="sv-name">${safe(g.path.slice(slash + 1))}</span>${dir}<span class="sv-count">${count}</span></div>`;
      for (const m of g.matches) {
        const i = this.flat.push({ path: g.path, m, g: gi }) - 1;
        if (g.collapsed) continue;
        const pv = m.preview;
        const on = i === this.sel;
        html += `<div class="sv-row${on ? " sel" : ""}" data-i="${i}" role="option"${on ? ' aria-selected="true"' : ""}><span class="sv-ln">${m.line}</span><span class="sv-pv">${safe(pv.slice(0, m.pcol))}<mark>${safe(pv.slice(m.pcol, m.pcol + m.len))}</mark>${safe(pv.slice(m.pcol + m.len))}</span></div>`;
      }
    });
    const n = d ? d.matches : total;
    const files = d ? d.files : this.groups.length;
    let head = `<div class="sv-summary">${plural(n, "result", "results")} in ${plural(files, "file", "files")}</div>`;
    if (d?.truncated === "matches") head += `<div class="sv-note sv-warn">Showing first 2,000 results</div>`;
    if (d?.truncated === "time") head += `<div class="sv-note sv-warn">Search timed out - showing partial results</div>`;
    if (d?.error || (!d && !this.running)) head += `<div class="sv-note sv-warn">Search ended early - showing partial results</div>`;
    this.results.innerHTML = head + skipped + html;
  }
}
