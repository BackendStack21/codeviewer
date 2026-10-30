import { api, type ChangeFile } from "./api.ts";
import { CodeView } from "./codeview.ts";
import { DiffView, type DiffInfo } from "./diffview.ts";
import { labelOf, letterOf } from "./changes.ts";
import { languageFor, languageName } from "./highlight.ts";
import { fileIcon, icons } from "./icons.ts";
import { isMarkdown } from "./markdown.ts";
import { MarkdownView } from "./mdview.ts";
import { decidePreview, tooLargeNote } from "./mdgate.ts";
import { planView, toggleLabel, toggleMode, viewMode } from "./viewstate.ts";
import { basename, debounce, dirname, esc, formatBytes, h, MOD } from "./util.ts";
import { GitState, relativeTime } from "./git.ts";

type Kind = "text" | "image" | "binary" | "error" | "dir";

export interface Tab {
  path: string;
  pinned: boolean;
  kind: Kind;
  el: HTMLElement;
  tabEl: HTMLElement;
  code?: CodeView;
  /** Rendered Markdown preview; mutually exclusive with `code`. */
  md?: MarkdownView;
  image?: ImageView;
  /** Read-only diff of a changed file (a "diff tab"): `file` is the change it shows. */
  diff?: DiffView;
  isDiff?: boolean;
  file?: ChangeFile;
  /** The old side of a diff tab, kept across reloads of the live file (keyed by rev and path). */
  oldBlob?: { key: string; text: string | null };
  lang: string;
  size: number;
  mtime: number;
  truncated: boolean;
  eol: "LF" | "CRLF";
  encoding: string;
  /** A line (and range) to show once the first load lands. */
  goto?: { line: number; col?: number; len?: number };
  /** Bumped per load/diff request; stale async results are dropped. */
  gen: number;
  /** HEAD oid + git status the gutter was computed for (skip identical refreshes). */
  gitKey: string;
  /** Git status changed while the tab was in the background. */
  gitStale: boolean;
  asSource: boolean;
  /** The user asked for the preview of a file over the size cap (Render anyway or the toggle). */
  forcePreview?: boolean;
  changedOnDisk: boolean;
  deleted: boolean;
}

export interface StatusInfo {
  path: string;
  kind: Kind;
  lang?: string;
  lines?: number;
  size?: number;
  eol?: string;
  encoding?: string;
  line?: number;
  dims?: string;
  zoom?: string;
  truncated?: boolean;
  /** Lines added/removed vs HEAD */
  diff?: { added: number; removed: number } | null;
  /** git status label, e.g. "Modified" */
  git?: string;
}

/** What diff tabs compare the working tree with. */
export interface DiffContext {
  /** Full object id of the old side; null when there is none (unborn branch). */
  rev: string | null;
  /** "vs main", "vs HEAD" */
  vs: string;
}

/** Tabs + content area. Dispatches files to the code, image or binary views. */
export class Editor {
  readonly el: HTMLElement;
  private tabsEl: HTMLElement;
  private crumbs: HTMLElement;
  private body: HTMLElement;
  private empty: HTMLElement;
  tabs: Tab[] = [];
  active: Tab | null = null;
  fontSize = 13;
  onActive: (tab: Tab | null) => void = () => {};
  onStatus: (s: StatusInfo | null) => void = () => {};
  onReveal: (path: string) => void = () => {};
  /** Opens a repo-relative link from a Markdown preview; false when the target does not exist. */
  onOpenLink: (path: string, hash?: string) => Promise<boolean> = async (p, hash) => {
    await this.open(p, { pin: true });
    if (hash) this.revealFragment(p, hash);
    return true;
  };
  /** Called whenever the set of tabs or the active tab changes. */
  onChange: () => void = () => {};
  /** A diff tab asked for the next/previous changed file. */
  onDiffStep: (dir: 1 | -1) => void = () => {};
  git: GitState | null = null;
  private diffContext: DiffContext = { rev: null, vs: "vs HEAD" };

  constructor(emptyContent: HTMLElement) {
    this.tabsEl = h("div", { class: "tabs", role: "tablist" });
    this.crumbs = h("div", { class: "crumbs" });
    this.empty = emptyContent;
    this.body = h("div", { class: "editor-body" }, this.empty);
    this.el = h("section", { class: "editor" }, h("div", { class: "tabbar" }, this.tabsEl), this.crumbs, this.body);
    this.tabsEl.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) this.tabsEl.scrollLeft += e.deltaY;
    }, { passive: true });
    this.render();
  }

  async open(path: string, opts: { pin?: boolean; line?: number; col?: number; len?: number; focus?: boolean } = {}) {
    let tab = this.tabs.find((t) => t.path === path && !t.isDiff);
    if (!tab) {
      // A single unpinned "preview" tab is reused while browsing.
      const preview = !opts.pin ? this.tabs.find((t) => !t.pinned) : undefined;
      tab = this.createTab(path, !!opts.pin);
      if (opts.line && isMarkdown(path)) tab.asSource = true; // a line only means something in the source
      if (preview) {
        const i = this.tabs.indexOf(preview);
        this.disposeTab(preview);
        this.tabs.splice(i, 1, tab);
      } else {
        const i = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
        this.tabs.splice(i, 0, tab);
      }
      this.activate(tab);
      await this.load(tab);
    } else {
      if (opts.pin) tab.pinned = true;
      this.activate(tab);
      if (opts.line && tab.md) await this.toSource(tab);
    }
    if (opts.line && tab.code) {
      if (opts.col !== undefined && opts.len) tab.code.showRange(opts.line - 1, opts.col, opts.col + opts.len);
      else tab.code.revealLine(opts.line - 1);
    } else if (opts.line && !tab.md && !tab.image) tab.goto = { line: opts.line, col: opts.col, len: opts.len }; // still loading
    if (opts.focus !== false) tab.code?.focus();
    this.render();
  }

  /**
   * Opens (or re-shows) the diff tab of a changed file. Like `open`, an unpinned tab is reused
   * while stepping through the list; a double-click or Shift+Enter pins it.
   */
  async openDiff(file: ChangeFile, ctx: DiffContext, opts: { pin?: boolean; focus?: boolean } = {}) {
    this.diffContext = ctx;
    let tab = this.tabs.find((t) => t.isDiff && t.path === file.path);
    if (!tab) {
      const preview = !opts.pin ? this.tabs.find((t) => !t.pinned) : undefined;
      tab = this.createTab(file.path, !!opts.pin, true);
      tab.file = file;
      if (preview) {
        const i = this.tabs.indexOf(preview);
        this.disposeTab(preview);
        this.tabs.splice(i, 1, tab);
      } else {
        const i = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
        this.tabs.splice(i, 0, tab);
      }
      this.activate(tab);
      await this.loadDiff(tab);
    } else {
      if (opts.pin) tab.pinned = true;
      const same = tab.gitKey === (ctx.rev ?? "") && tab.file?.status === file.status && tab.file.oldPath === file.oldPath;
      tab.file = file;
      this.activate(tab);
      if (!same) await this.loadDiff(tab);
    }
    if (opts.focus !== false) tab.diff?.focus();
    this.render();
  }

  /**
   * New comparison data: diff tabs follow the base (a commit moved HEAD, the scope changed) and
   * pick up their file's new status. Files that left the list keep their tab (it shows no differences).
   */
  refreshDiffs(ctx: DiffContext, files: readonly ChangeFile[]) {
    this.diffContext = ctx;
    for (const t of this.tabs) {
      if (!t.isDiff || !t.file) continue;
      // A file that left the list now equals the base: diff it as a plain modification (no differences).
      const f = files.find((x) => x.path === t.path) ?? { ...t.file, status: "M" as const, oldPath: undefined, added: null, removed: null };
      const moved = f.status !== t.file.status || f.oldPath !== t.file.oldPath;
      t.file = f;
      if (t.gitKey !== (ctx.rev ?? "") || moved) void this.loadDiff(t);
      else t.diff?.setInfo(this.diffInfo(t.file));
    }
  }

  /** Shows "n/N" in every diff tab's header. */
  setDiffPositions(pos: (path: string) => { i: number; n: number } | null) {
    for (const t of this.tabs) if (t.isDiff) t.diff?.setPosition(pos(t.path));
  }

  private diffInfo(f: ChangeFile): DiffInfo {
    return { path: f.path, oldPath: f.oldPath, letter: letterOf(f.status), label: labelOf(f), vs: this.diffContext.vs };
  }

  private async loadDiff(tab: Tab) {
    const f = tab.file!;
    const ctx = this.diffContext;
    const gen = ++tab.gen;
    const letter = letterOf(f.status);
    if (!tab.diff) {
      tab.diff = new DiffView(this.diffInfo(f), tab.lang, this.fontSize);
      tab.diff.onStep = (d) => this.onDiffStep(d);
      tab.diff.onOpenFile = () => void this.open(tab.path, { pin: true }).then(() => this.active?.code?.nextChange(1));
      tab.el.replaceChildren(tab.diff.el);
    } else tab.diff.setInfo(this.diffInfo(f));
    const diff = tab.diff;
    tab.gitKey = ctx.rev ?? "";
    tab.kind = "text";
    if (f.binary) diff.setTexts(null, null, "Binary file changed.");
    else {
      // Untracked and added files have no old side; deleted files no new side.
      const wantOld = !!ctx.rev && letter !== "U" && letter !== "A";
      const wantNew = letter !== "D";
      // The old side only changes with the base: reuse it while the live file is reloaded.
      const oldKey = `${ctx.rev}:${f.oldPath ?? f.path}`;
      const cached = wantOld && tab.oldBlob?.key === oldKey ? tab.oldBlob : null;
      const [oldText, nf] = await Promise.all([
        !wantOld ? Promise.resolve("") : cached ? Promise.resolve(cached.text) : api.gitBase(f.oldPath ?? f.path, ctx.rev!),
        wantNew ? api.file(f.path).catch(() => null) : Promise.resolve(null),
      ]);
      if (gen !== tab.gen || tab.diff !== diff) return;
      if (wantOld) tab.oldBlob = { key: oldKey, text: oldText };
      if (nf) {
        tab.size = nf.size;
        tab.mtime = nf.mtime;
        tab.truncated = nf.truncated;
        tab.encoding = nf.encoding;
      }
      if (wantOld && oldText === null) diff.setTexts(null, null, "The previous version can't be shown (binary or too large).");
      else if (nf && nf.kind !== "text") diff.setTexts(null, null, "Binary file changed.");
      else diff.setTexts(oldText ?? "", nf ? nf.text : ""); // a file gone from disk diffs as deleted
    }
    tab.deleted = false;
    if (tab === this.active) this.status();
    this.render();
  }

  private createTab(path: string, pinned: boolean, isDiff = false): Tab {
    const el = h("div", { class: "view" });
    const tabEl = h("div", { class: "tab", role: "tab", title: path });
    const tab: Tab = {
      path, pinned, kind: "text", el, tabEl, lang: languageFor(path), size: 0, mtime: 0, truncated: false,
      eol: "LF", encoding: "UTF-8", gen: 0, gitKey: "", gitStale: false, asSource: false, changedOnDisk: false, deleted: false,
    };
    if (isDiff) tab.isDiff = true;
    tabEl.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.close(tab);
      } else if (e.button === 0 && !(e.target as HTMLElement).closest(".tab-close")) this.activate(tab);
    });
    tabEl.addEventListener("dblclick", () => {
      tab.pinned = true;
      this.render();
    });
    return tab;
  }

  private async load(tab: Tab, reload = false) {
    if (tab.isDiff) return this.loadDiff(tab);
    const gen = ++tab.gen;
    try {
      const f = await api.file(tab.path, tab.asSource);
      if (gen !== tab.gen) return; // a newer reload is in flight
      tab.size = f.size;
      tab.mtime = f.mtime;
      tab.truncated = f.truncated;
      tab.encoding = f.encoding;
      tab.deleted = false;
      const mode = { asSource: tab.asSource, forcePreview: !!tab.forcePreview };
      const showSource = viewMode(tab.path, f.size, f.truncated, mode) === "source";
      const tooLarge = f.kind === "text" && isMarkdown(tab.path) && !tab.asSource && decidePreview(f.size, f.truncated, mode.forcePreview).tooLarge;
      const plan = planView({ kind: f.kind, path: tab.path, asSource: showSource, reload, hasMd: !!tab.md, hasCode: !!tab.code });
      // The tab keeps only the views the plan names, so a Markdown tab that goes binary/dir/image can't get stuck.
      if (!plan.md) {
        tab.md?.dispose();
        tab.md = undefined;
      }
      if (!plan.code) this.dropCode(tab);
      if (f.kind === "text") {
        tab.eol = /\r\n/.test(f.text.slice(0, 10000)) ? "CRLF" : "LF";
        if (plan.view === "md") {
          if (plan.reuse) tab.md!.setText(f.text);
          else {
            tab.md = new MarkdownView(f.text, this.fontSize, { path: tab.path, onOpen: (p, hash) => this.onOpenLink(p, hash) });
            tab.el.replaceChildren(tab.md.el);
            tab.el.prepend(this.viewToggle(tab, toggleLabel("preview"), icons.code));
          }
        } else if (plan.reuse) tab.code!.setText(f.text);
        else {
          tab.el.replaceChildren();
          tab.code?.dispose();
          tab.code = new CodeView(f.text, tab.lang, this.fontSize);
          const code = tab.code;
          const blame = debounce((line: number) => void this.loadBlame(tab, code, line), 180);
          code.onActiveLine = (line) => {
            this.status();
            code.setBlame(line, null);
            blame(line);
          };
          tab.el.append(tab.code.el);
          if (tab.path.endsWith(".svg")) tab.el.prepend(this.viewToggle(tab, "Preview image", icons.image));
          else if (isMarkdown(tab.path)) {
            tab.el.prepend(this.viewToggle(tab, toggleLabel("source"), icons.image));
            if (tooLarge) {
              tab.el.prepend(
                tooLargeNote(() => {
                  tab.forcePreview = true;
                  this.dropCode(tab);
                  void this.load(tab);
                }),
              );
            }
          }
        }
        if (tab.goto && tab.code) {
          const g = tab.goto;
          tab.goto = undefined;
          if (g.col !== undefined && g.len) tab.code.showRange(g.line - 1, g.col, g.col + g.len);
          else tab.code.revealLine(g.line - 1);
        }
        await this.refreshGit(tab, !reload);
      } else if (f.kind === "image") {
        if (tab.image && reload) tab.image.reload(tab.mtime);
        else {
          this.dropCode(tab);
          tab.image = new ImageView(tab.path, tab.mtime, () => this.status());
          tab.el.replaceChildren(tab.image.el);
          if (tab.path.endsWith(".svg")) tab.el.prepend(this.viewToggle(tab, "View source", icons.code));
        }
      } else if (f.kind === "binary") {
        this.dropCode(tab);
        tab.el.replaceChildren(await binaryView(tab.path, f.size));
      } else {
        this.dropCode(tab);
        tab.el.replaceChildren(h("div", { class: "notice" }, "This is a directory."));
      }
      tab.kind = f.kind;
    } catch (e) {
      if (reload) {
        tab.deleted = true;
        this.render();
        return;
      }
      tab.kind = "error";
      this.dropCode(tab);
      tab.md?.dispose();
      tab.md = undefined;
      tab.el.replaceChildren(h("div", { class: "notice error" }, h("strong", null, "Can't open file"), h("span", null, (e as Error).message)));
    }
    if (tab === this.active) this.status();
    this.render();
  }

  private viewToggle(tab: Tab, label: string, icon: string): HTMLElement {
    return h(
      "button",
      {
        class: "view-toggle",
        onclick: () => this.flip(tab),
      },
      h("span", { html: icon }),
      label,
    );
  }

  private flip(tab: Tab) {
    if (isMarkdown(tab.path)) {
      const next = toggleMode(tab.path, tab.size, tab.truncated, { asSource: tab.asSource, forcePreview: !!tab.forcePreview });
      tab.asSource = next.asSource;
      tab.forcePreview = next.forcePreview; // an explicit request overrides the size gate
    } else tab.asSource = !tab.asSource; // SVG: image or source
    this.dropCode(tab);
    tab.image = undefined;
    tab.md?.dispose();
    tab.md = undefined;
    void this.load(tab);
  }

  /** The active tab is a text file that can switch between preview and source. */
  isMarkdownTab(): boolean {
    const t = this.active;
    return !!t && t.kind === "text" && isMarkdown(t.path);
  }

  toggleMarkdown() {
    if (this.active && this.isMarkdownTab()) this.flip(this.active);
  }

  /** Scrolls an open Markdown preview to a heading fragment. */
  revealFragment(path: string, hash: string) {
    this.tabs.find((t) => t.path === path)?.md?.scrollToFragment(hash);
  }

  activate(tab: Tab) {
    if (this.active === tab) return;
    this.active?.code?.setVisible(false);
    this.active = tab;
    this.body.replaceChildren(tab.el);
    tab.code?.setVisible(true);
    tab.code?.schedule();
    tab.diff?.schedule();
    if (tab.gitStale) void this.refreshGit(tab);
    this.render();
    this.status();
    this.onActive(tab);
    tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  close(tab: Tab | null = this.active) {
    if (!tab) return;
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    this.disposeTab(tab);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) {
        this.activate(next);
        if (document.activeElement === document.body) (next.code ?? next.diff)?.focus();
      } else {
        this.body.replaceChildren(this.empty);
        this.onActive(null);
        this.status();
      }
    }
    this.render();
  }

  closeAll() {
    for (const t of [...this.tabs]) this.close(t);
  }

  /** Leaves the Markdown preview for the source view (find and line jumps only make sense there). */
  private async toSource(tab: Tab) {
    tab.asSource = true;
    tab.md?.dispose();
    tab.md = undefined;
    await this.load(tab);
  }

  private dropCode(tab: Tab) {
    tab.code?.dispose();
    tab.code = undefined;
  }

  private disposeTab(tab: Tab) {
    tab.gen++; // a load still in flight must not build a view for a closed tab
    tab.code?.dispose();
    tab.diff?.dispose();
    tab.md?.dispose();
    tab.el.remove();
    tab.tabEl.remove();
  }

  cycle(dir: 1 | -1) {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]!);
  }

  /** Called with watcher paths; open tabs reload in place. */
  onChanged(paths: string[]) {
    const set = new Set(paths);
    for (const t of this.tabs) if (set.has(t.path)) void this.load(t, true);
  }

  // ───────────────────────────── git ─────────────────────────────

  /** Re-diffs every open text tab against HEAD (status, index or HEAD changed). */
  onGitChanged() {
    // Only the visible tab is re-diffed now; background tabs catch up when shown.
    for (const t of this.tabs) t.gitStale = true;
    if (this.active) void this.refreshGit(this.active);
    this.render();
    this.status();
  }

  private async refreshGit(tab: Tab, force = false) {
    const code = tab.code;
    tab.gitStale = false;
    if (!code) return;
    const g = this.git?.repo ? this.git.file(tab.path) : null;
    // The HEAD blob only changes with HEAD; the file's own edits are re-diffed by setText.
    const key = `${this.git?.status.oid ?? ""}|${g?.xy ?? ""}`;
    if (!force && key === tab.gitKey) return;
    tab.gitKey = key;
    const gen = tab.gen;
    if (!this.git?.repo || g?.letter === "I") code.setGit(null, false);
    else if (g?.letter === "U") code.setGit(null, true);
    else if (g?.xy[0] === "A") code.setGit("", false); // staged new file: HEAD has nothing
    else {
      const base = await api.gitBase(tab.path);
      if (gen !== tab.gen || tab.code !== code) return;
      code.setGit(base, false);
    }
    if (tab === this.active) this.status();
  }

  private async loadBlame(tab: Tab, code: CodeView, line: number) {
    const g = this.git?.repo ? this.git.file(tab.path) : null;
    if (!this.git?.repo || line < 0 || g?.letter === "U" || g?.letter === "I" || g?.letter === "A") return;
    const b = await api.gitBlame(tab.path, line + 1);
    if (!b || tab.code !== code || code.activeLine !== line) return;
    const who = b.you ? "You" : esc(b.author);
    const html = b.uncommitted ? "You · uncommitted change" : `${who}, ${relativeTime(b.time)} · ${esc(b.summary)}`;
    code.setBlame(line, html);
  }

  setFontSize(px: number) {
    this.fontSize = px;
    for (const t of this.tabs) {
      t.code?.setFontSize(px);
      t.md?.setFontSize(px);
      t.diff?.setFontSize(px);
    }
  }

  openFind() {
    const t = this.active;
    if (t?.md) return void this.toSource(t).then(() => t.code?.openFind());
    t?.code?.openFind();
  }

  /** Next/previous change in the file; in a diff tab, past the last change it moves on to the next file. */
  nextChange(dir: 1 | -1) {
    const t = this.active;
    if (t?.diff) {
      if (!t.diff.nextChange(dir)) this.onDiffStep(dir);
      return;
    }
    t?.code?.nextChange(dir);
  }

  goToLine(line: number) {
    const t = this.active;
    if (t?.md) return void this.toSource(t).then(() => t.code?.revealLine(line - 1));
    t?.code?.revealLine(line - 1);
  }

  private status() {
    const t = this.active;
    if (!t) return this.onStatus(null);
    const s: StatusInfo = { path: t.path, kind: t.kind, size: t.size, truncated: t.truncated };
    if (t.diff && t.file) {
      s.lang = languageName(t.lang);
      s.git = `${labelOf(t.file)} ${this.diffContext.vs}`;
      s.diff = t.diff.stats;
      s.encoding = t.encoding;
      return this.onStatus(s);
    }
    const g = this.git?.repo ? this.git.file(t.path) : null;
    if (g && g.letter !== "I") s.git = g.label;
    if (t.code) {
      s.lang = languageName(t.lang);
      s.lines = t.code.lineCount;
      s.eol = t.eol;
      s.encoding = t.encoding;
      s.line = t.code.activeLine >= 0 ? t.code.activeLine + 1 : undefined;
      s.diff = t.code.gitStats;
    }
    if (t.md) {
      s.lang = "Markdown";
      s.eol = t.eol;
      s.encoding = t.encoding;
    }
    if (t.image) {
      s.dims = t.image.dims;
      s.zoom = t.image.zoomLabel;
    }
    this.onStatus(s);
  }

  render() {
    // Same-named files from different folders: show the nearest folder that differs.
    const byName = new Map<string, Set<string>>();
    for (const t of this.tabs) (byName.get(basename(t.path)) ?? byName.set(basename(t.path), new Set()).get(basename(t.path))!).add(t.path);
    const hint = (p: string) => {
      const paths = byName.get(basename(p))!;
      if (paths.size < 2) return "";
      const dir = dirname(p);
      const parent = dir.slice(dir.lastIndexOf("/") + 1);
      const parents = new Set([...paths].map((x) => dirname(x)).map((d) => d.slice(d.lastIndexOf("/") + 1)));
      return parents.size === paths.size ? parent : dir || "/";
    };
    for (const t of this.tabs) {
      const cls = ["tab"];
      if (t === this.active) cls.push("active");
      if (!t.pinned) cls.push("preview");
      if (t.deleted) cls.push("deleted");
      if (t.isDiff) cls.push("diff");
      const g = t.isDiff && t.file ? { letter: letterOf(t.file.status), label: labelOf(t.file) } : this.git?.repo ? this.git.file(t.path) : null;
      if (g) cls.push(`git-${g.letter}`);
      t.tabEl.className = cls.join(" ");
      t.tabEl.title = g ? `${t.path} · ${g.label}${t.isDiff ? ` · diff ${this.diffContext.vs}` : ""}` : t.path;
      t.tabEl.setAttribute("aria-selected", String(t === this.active));
      t.tabEl.innerHTML = `${fileIcon(t.path)}<span class="tab-name">${esc(basename(t.path))}</span>${hint(t.path) ? `<span class="tab-dir">${esc(hint(t.path))}</span>` : ""}${t.isDiff ? '<span class="tab-kind">diff</span>' : ""}<button class="tab-close" title="Close (${MOD}W)">${icons.close}</button>`;
      t.tabEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
        e.stopPropagation();
        this.close(t);
      });
    }
    this.tabsEl.replaceChildren(...this.tabs.map((t) => t.tabEl));
    // Breadcrumbs
    this.crumbs.replaceChildren();
    if (this.active) {
      const parts = this.active.path.split("/");
      parts.forEach((p, i) => {
        const full = parts.slice(0, i + 1).join("/");
        const isLast = i === parts.length - 1;
        this.crumbs.append(
          h("button", { class: `crumb${isLast ? " last" : ""}`, onclick: () => this.onReveal(full), title: full }, p),
        );
        if (!isLast) this.crumbs.append(h("span", { class: "crumb-sep" }, "›"));
      });
      if (this.active.isDiff) this.crumbs.append(h("span", { class: "pill" }, `diff ${this.diffContext.vs}`));
      if (this.active.truncated) this.crumbs.append(h("span", { class: "pill warn" }, `showing first ${formatBytes(8 * 1024 * 1024)}`));
      if (this.active.deleted) this.crumbs.append(h("span", { class: "pill warn" }, "deleted on disk"));
    }
    this.el.classList.toggle("has-tabs", this.tabs.length > 0);
    this.onChange();
  }

  serialize() {
    // Diff tabs are not restored: the changes they showed are gone by the next session.
    return { tabs: this.tabs.filter((t) => t.pinned && !t.isDiff).map((t) => t.path), active: this.active && !this.active.isDiff ? this.active.path : null };
  }
}

class ImageView {
  readonly el: HTMLElement;
  private img: HTMLImageElement;
  private stage: HTMLElement;
  private mode: "fit" | number = "fit";
  dims = "";

  constructor(
    private path: string,
    mtime: number,
    private onInfo: () => void,
  ) {
    this.img = h("img", { class: "img", alt: basename(path), draggable: "false" });
    this.stage = h("div", { class: "img-stage" }, this.img);
    const bar = h(
      "div",
      { class: "img-bar" },
      h("button", { onclick: () => this.setMode("fit") }, "Fit"),
      h("button", { onclick: () => this.setMode(1) }, "1:1"),
      h("button", { onclick: () => this.zoom(1 / 1.25), title: "Zoom out" }, "−"),
      h("button", { onclick: () => this.zoom(1.25), title: "Zoom in" }, "+"),
    );
    this.el = h("div", { class: "image-view" }, this.stage, bar);
    this.img.addEventListener("load", () => {
      this.dims = `${this.img.naturalWidth} × ${this.img.naturalHeight}`;
      this.apply();
    });
    this.img.addEventListener("error", () => {
      this.stage.replaceChildren(h("div", { class: "notice error" }, "This image could not be decoded."));
    });
    this.stage.addEventListener("dblclick", () => this.setMode(this.mode === "fit" ? 1 : "fit"));
    this.stage.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.zoom(Math.exp(-e.deltaY * 0.01));
      },
      { passive: false },
    );
    new ResizeObserver(() => this.mode === "fit" && this.apply()).observe(this.stage);
    this.reload(mtime);
  }

  private blobUrl = "";

  reload(_mtime: number) {
    void api.rawBlobUrl(this.path).then(
      (u) => {
        if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
        this.blobUrl = u;
        this.img.src = u;
      },
      () => this.img.dispatchEvent(new Event("error")),
    );
  }

  get zoomLabel() {
    return `${Math.round(this.scale() * 100)}%`;
  }

  private scale(): number {
    if (this.mode !== "fit") return this.mode;
    const w = this.img.naturalWidth || 1;
    const hgt = this.img.naturalHeight || 1;
    const r = this.stage.getBoundingClientRect();
    return Math.min(1, (r.width - 48) / w, (r.height - 48) / hgt);
  }

  private zoom(f: number) {
    this.mode = Math.max(0.02, Math.min(64, this.scale() * f));
    this.apply();
  }

  private setMode(m: "fit" | number) {
    this.mode = m;
    this.apply();
  }

  private apply() {
    const s = this.scale();
    this.img.style.width = `${(this.img.naturalWidth || 0) * s}px`;
    this.img.style.height = `${(this.img.naturalHeight || 0) * s}px`;
    this.img.classList.toggle("pixelated", s >= 3);
    this.onInfo();
  }
}

async function binaryView(path: string, size: number): Promise<HTMLElement> {
  const bytes = await api.head(path, 4096).catch(() => new Uint8Array());
  let rows = "";
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.subarray(off, off + 16);
    let hex = "";
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      const b = chunk[i];
      hex += b === undefined ? "   " : b.toString(16).padStart(2, "0") + " ";
      if (i === 7) hex += " ";
      ascii += b === undefined ? "" : b >= 32 && b < 127 ? String.fromCharCode(b) : "·";
    }
    rows += `<div><span class="hx-off">${off.toString(16).padStart(8, "0")}</span>  <span class="hx-hex">${hex}</span> <span class="hx-asc">${esc(ascii)}</span></div>`;
  }
  return h(
    "div",
    { class: "binary-view" },
    h("div", { class: "binary-head" }, h("strong", null, "Binary file"), h("span", null, `${formatBytes(size)}${size > 4096 ? " · showing first 4 KB" : ""}`)),
    h("div", { class: "hexdump", html: rows }),
  );
}
