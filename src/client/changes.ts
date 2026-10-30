import { api, type ChangeFile, type ChangesData } from "./api.ts";
import type { Letter } from "./git.ts";
import { basename, dirname, esc, h, showHidden } from "./util.ts";

export type Scope = "head" | "branch";

/** Explorer vocabulary for git's raw status letters: untracked → U, unmerged → C, copied → R, type change → M. */
export function letterOf(status: ChangeFile["status"]): Letter {
  switch (status) {
    case "?": return "U";
    case "U": case "X": return "C";
    case "C": return "R";
    case "A": case "D": case "R": case "M": return status;
    default: return "M";
  }
}

const LABEL: Record<Letter, string> = { M: "Modified", A: "Added", U: "Untracked", D: "Deleted", R: "Renamed", C: "Conflict", I: "Ignored" };
export function labelOf(f: ChangeFile): string {
  if (f.status === "T") return "Type changed";
  if (f.status === "C") return "Copied";
  return LABEL[letterOf(f.status)];
}

/** Surprises first: conflicts, deletions, new files, renames, then edits; ties by path. */
const ORDER: Record<Letter, number> = { C: 0, D: 1, U: 2, A: 2, R: 3, M: 4, I: 5 };
export function sortChanges(files: readonly ChangeFile[]): ChangeFile[] {
  return [...files].sort((a, b) => ORDER[letterOf(a.status)] - ORDER[letterOf(b.status)] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function summarize(files: readonly ChangeFile[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added ?? 0;
    removed += f.removed ?? 0;
  }
  return { added, removed };
}

/** What "reviewed" was reviewed against: any later edit to the file un-dims its row. */
const seenKey = (f: ChangeFile) => `${f.status}:${f.added}:${f.removed}:${f.oldPath ?? ""}`;

const safe = (s: string) => esc(showHidden(s));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Sidebar view listing the files changed on the branch (vs the merge-base with the base branch,
 * working tree included) or only the uncommitted ones (vs HEAD), with a one-line summary.
 */
export class ChangesView {
  readonly el: HTMLElement;
  onOpen: (file: ChangeFile, pin: boolean) => void = () => {};
  /** Fresh data arrived (or the repo went away): diff tabs follow the comparison base. */
  onData: (d: ChangesData | null) => void = () => {};
  data: ChangesData | null = null;
  files: ChangeFile[] = [];
  private scope: Scope = "branch";
  private repo = false;
  private visible = false;
  private stale = true;
  private loading = false;
  private again = false;
  private error = false;
  private gen = 0;
  private timer = 0;
  private debounce: number;
  private sel = -1;
  private current: string | null = null;
  /** Diff tabs are open: keep refreshing while the view is hidden so they follow the base. */
  watching = false;
  private seen = new Map<string, string>();
  private scopeEl: HTMLElement;
  private summary: HTMLElement;
  private list: HTMLElement;

  constructor(opts: { debounce?: number } = {}) {
    this.debounce = opts.debounce ?? 150;
    this.scopeEl = h("div", { class: "ch-scope", role: "group", "aria-label": "Comparison", hidden: true });
    this.summary = h("div", { class: "ch-summary-wrap", hidden: true });
    this.list = h("div", { class: "ch-list", role: "listbox", tabindex: "0", "aria-label": "Changed files" });
    this.el = h("div", { class: "changes-view" }, this.scopeEl, this.summary, this.list);
    this.scopeEl.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".ch-seg");
      if (b?.dataset.scope) this.setScope(b.dataset.scope as Scope);
    });
    this.list.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".ch-row");
      if (!row) return;
      this.sel = Number(row.dataset.i);
      this.accept(false);
    });
    this.list.addEventListener("dblclick", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".ch-row");
      if (!row) return;
      this.sel = Number(row.dataset.i);
      this.accept(true);
    });
    this.list.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") this.move(e.key === "ArrowDown" ? 1 : -1);
      else if (e.key === "Enter") this.accept(!!e.shiftKey);
      else if (e.key === "Home" || e.key === "End") this.select(e.key === "Home" ? 0 : this.files.length - 1);
      else return;
      e.preventDefault();
    });
    this.render();
  }

  get scopeName(): Scope {
    return this.scope;
  }

  /** Human label of what the list is compared with ("vs main", "vs HEAD"). */
  get vs(): string {
    const d = this.data;
    return d?.scope === "branch" && d.base ? `vs ${d.base.name}` : "vs HEAD";
  }

  setRepo(repo: boolean) {
    if (repo === this.repo) return;
    this.repo = repo;
    if (!repo) {
      this.gen++;
      this.data = null;
      this.files = [];
      this.loading = false;
      this.onData(null);
    } else this.stale = true;
    this.render();
    if (repo && this.visible) void this.refresh();
  }

  setScope(scope: Scope) {
    if (scope === this.scope) return;
    this.scope = scope;
    this.sel = -1;
    void this.refresh();
  }

  /** Status, index or refs changed: refresh now when the list is in use, else on the next show. */
  onGitChanged() {
    if (!this.repo) return;
    this.stale = true;
    if (this.visible || this.watching) this.schedule();
  }

  onShown() {
    this.visible = true;
    if (this.repo && this.stale) void this.refresh();
  }

  onHidden() {
    this.visible = false;
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.debounce <= 0) return void this.refresh();
    this.timer = window.setTimeout(() => void this.refresh(), this.debounce);
  }

  async refresh() {
    clearTimeout(this.timer);
    if (!this.repo) return;
    if (this.loading) {
      this.again = true; // one request at a time: the newest wish is honoured when it ends
      return;
    }
    const gen = ++this.gen;
    this.stale = false;
    this.loading = true;
    if (!this.data) this.render();
    try {
      const d = await api.gitChanges(this.scope);
      if (gen !== this.gen) return;
      this.error = false;
      if (!d.repo) {
        this.data = null;
        this.files = [];
      } else {
        this.data = d;
        this.files = sortChanges(d.files);
        for (const k of [...this.seen.keys()]) if (!this.files.some((f) => f.path === k)) this.seen.delete(k);
      }
    } catch {
      if (gen !== this.gen) return;
      this.error = true;
    } finally {
      if (gen === this.gen) {
        this.loading = false;
        this.render();
        this.onData(this.data);
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      }
    }
  }

  /** The file whose diff is open (highlighted and marked as reviewed). */
  setCurrent(path: string | null) {
    this.current = path;
    const f = path === null ? undefined : this.files.find((x) => x.path === path);
    if (f) this.seen.set(f.path, seenKey(f));
    this.render();
  }

  /** 1-based position of a file in the list and the list length; null when it is not listed. */
  position(path: string | null = this.current): { i: number; n: number } | null {
    const i = this.files.findIndex((f) => f.path === path);
    return i < 0 ? null : { i: i + 1, n: this.files.length };
  }

  /** Switches between the two comparisons when a base branch is known. */
  toggleScope() {
    if (!this.data?.base || this.data.base.same) return;
    this.setScope(this.scope === "branch" ? "head" : "branch");
  }

  /** Opens the file after/before the current one (wrapping); null when the list is empty. */
  step(dir: 1 | -1): ChangeFile | null {
    const n = this.files.length;
    if (!n) return null;
    const at = this.files.findIndex((f) => f.path === this.current);
    const next = at < 0 ? (dir === 1 ? 0 : n - 1) : (at + dir + n) % n;
    this.sel = next;
    const f = this.files[next]!;
    this.onOpen(f, false);
    return f;
  }

  focus() {
    if (this.sel < 0) this.sel = Math.max(0, this.files.findIndex((f) => f.path === this.current));
    this.render();
    this.list.focus();
  }

  private move(dir: 1 | -1) {
    if (!this.files.length) return;
    this.select(this.sel < 0 ? (dir === 1 ? 0 : this.files.length - 1) : Math.max(0, Math.min(this.files.length - 1, this.sel + dir)));
  }

  private select(i: number) {
    if (!this.files.length) return;
    this.sel = Math.max(0, Math.min(this.files.length - 1, i));
    // Move the selection on the rows in place; a full rebuild is for data changes.
    const rows = this.list.querySelectorAll<HTMLElement>(".ch-row");
    if (rows.length === this.files.length) {
      rows.forEach((r, k) => {
        r.classList.toggle("sel", k === this.sel);
        r.setAttribute("aria-selected", String(k === this.sel));
      });
    } else this.render();
    this.syncActive();
    this.list.querySelector(".ch-row.sel")?.scrollIntoView?.({ block: "nearest" });
  }

  private syncActive() {
    if (this.sel >= 0 && this.sel < this.files.length) this.list.setAttribute("aria-activedescendant", `ch-${this.sel}`);
    else this.list.removeAttribute("aria-activedescendant");
  }

  private accept(pin: boolean) {
    const f = this.files[this.sel];
    if (f) this.onOpen(f, pin);
  }

  private render() {
    const d = this.data;
    // Scope control: only when there is a base branch and HEAD has commits on top of it.
    const switchable = !!d?.base && !d.base.same;
    this.scopeEl.hidden = !switchable;
    if (switchable) {
      const seg = (scope: Scope, label: string) =>
        `<button type="button" class="ch-seg" data-scope="${scope}" aria-pressed="${String(this.scope === scope)}">${label}</button>`;
      this.scopeEl.innerHTML = seg("head", "Uncommitted") + seg("branch", `vs ${safe(d!.base!.name)}`);
    }
    if (!this.repo) {
      this.summary.hidden = true;
      this.list.innerHTML = `<div class="sv-msg">Not a git repository.</div>`;
      return;
    }
    if (this.error) {
      this.summary.hidden = true;
      this.list.innerHTML = `<div class="sv-msg sv-error">Could not read the changes.</div>`;
      return;
    }
    if (!d) {
      this.summary.hidden = true;
      this.list.innerHTML = `<div class="sv-msg">${this.loading ? "Reading changes…" : ""}</div>`;
      return;
    }
    const files = this.files;
    const { added, removed } = summarize(files);
    this.summary.hidden = false;
    const commits = d.scope === "branch" && d.commits
      ? `<span class="ch-sep">·</span><span class="ch-commits" title="${esc(d.subjects.map(showHidden).join("\n"))}">${plural(d.commits, "commit", "commits")}</span>`
      : "";
    const p = added + removed ? Math.round((added / (added + removed)) * 100) : 50;
    this.summary.innerHTML =
      `<div class="ch-summary"><span class="ch-counts"><b>${files.length}</b> ${files.length === 1 ? "file" : "files"}` +
      `<span class="ch-sep">·</span><span class="git-A">+${added.toLocaleString()}</span> <span class="git-D">−${removed.toLocaleString()}</span>${commits}</span>` +
      `<span class="ch-vs">${safe(this.vs)}</span></div>` +
      `<div class="ch-bar${added + removed ? "" : " empty"}" style="--p:${p}%"></div>`;
    if (!files.length) {
      const msg = d.scope === "branch" && d.base
        ? d.commits ? `No changes ${safe(this.vs)}.` : `Branch is up to date with ${safe(d.base.name)}.`
        : "No uncommitted changes.";
      this.list.innerHTML = `<div class="sv-msg">${msg}</div>`;
      return;
    }
    let html = "";
    files.forEach((f, i) => {
      const letter = letterOf(f.status);
      const cls = ["ch-row", `git-${letter}`];
      if (i === this.sel) cls.push("sel");
      if (f.path === this.current) cls.push("cur");
      if (this.seen.get(f.path) === seenKey(f)) cls.push("seen");
      if (letter === "D") cls.push("deleted");
      let name = safe(basename(f.path));
      let dir = safe(dirname(f.path));
      if (f.oldPath !== undefined) {
        const ob = basename(f.oldPath);
        const od = dirname(f.oldPath);
        if (ob !== basename(f.path)) name = `${safe(ob)}<span class="ch-arrow">→</span>${name}`;
        if (od !== dirname(f.path)) dir = `${safe(od)}<span class="ch-arrow">→</span>${dir}`;
      }
      const counts = f.binary
        ? `<span class="ch-bin">bin</span>`
        : f.added === null
          ? `<span class="ch-bin">—</span>`
          : `<span class="ch-add">${f.added ? `+${f.added}` : ""}</span><span class="ch-del">${f.removed ? `−${f.removed}` : ""}</span>`;
      html +=
        `<div class="${cls.join(" ")}" data-i="${i}" id="ch-${i}" role="option" aria-selected="${i === this.sel}" title="${esc(showHidden(f.path))} · ${labelOf(f)}${cls.includes("seen") ? " · reviewed (dims until the file changes again)" : ""}">` +
        `<span class="gbadge">${letter}</span><span class="ch-name">${name}</span><span class="ch-dir">${dir}</span>${counts}</div>`;
    });
    if (d.truncated) html += `<div class="sv-note sv-warn">Showing the first ${files.length.toLocaleString()} files</div>`;
    this.list.innerHTML = html;
    this.syncActive();
  }
}
