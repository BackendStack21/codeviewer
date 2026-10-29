import { api } from "./api.ts";
import { CodeView } from "./codeview.ts";
import { languageFor, languageName } from "./highlight.ts";
import { fileIcon, icons } from "./icons.ts";
import { basename, debounce, esc, formatBytes, h, MOD } from "./util.ts";
import { GitState, relativeTime } from "./git.ts";

type Kind = "text" | "image" | "binary" | "error" | "dir";

export interface Tab {
  path: string;
  pinned: boolean;
  kind: Kind;
  el: HTMLElement;
  tabEl: HTMLElement;
  code?: CodeView;
  image?: ImageView;
  lang: string;
  size: number;
  mtime: number;
  truncated: boolean;
  eol: "LF" | "CRLF";
  encoding: string;
  /** Bumped per load/diff request; stale async results are dropped. */
  gen: number;
  /** HEAD oid + git status the gutter was computed for (skip identical refreshes). */
  gitKey: string;
  /** Git status changed while the tab was in the background. */
  gitStale: boolean;
  asSource: boolean;
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
  /** Called whenever the set of tabs or the active tab changes. */
  onChange: () => void = () => {};
  git: GitState | null = null;

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
    let tab = this.tabs.find((t) => t.path === path);
    if (!tab) {
      // A single unpinned "preview" tab is reused while browsing.
      const preview = !opts.pin ? this.tabs.find((t) => !t.pinned) : undefined;
      tab = this.createTab(path, !!opts.pin);
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
    }
    if (opts.line && tab.code) {
      if (opts.col !== undefined && opts.len) tab.code.showRange(opts.line - 1, opts.col, opts.col + opts.len);
      else tab.code.revealLine(opts.line - 1);
    }
    if (opts.focus !== false) tab.code?.focus();
    this.render();
  }

  private createTab(path: string, pinned: boolean): Tab {
    const el = h("div", { class: "view" });
    const tabEl = h("div", { class: "tab", role: "tab", title: path });
    const tab: Tab = {
      path, pinned, kind: "text", el, tabEl, lang: languageFor(path), size: 0, mtime: 0, truncated: false,
      eol: "LF", encoding: "UTF-8", gen: 0, gitKey: "", gitStale: false, asSource: false, changedOnDisk: false, deleted: false,
    };
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
    const gen = ++tab.gen;
    try {
      const f = await api.file(tab.path, tab.asSource);
      if (gen !== tab.gen) return; // a newer reload is in flight
      tab.size = f.size;
      tab.mtime = f.mtime;
      tab.truncated = f.truncated;
      tab.encoding = f.encoding;
      tab.deleted = false;
      if (f.kind === "text") {
        tab.eol = /\r\n/.test(f.text.slice(0, 10000)) ? "CRLF" : "LF";
        if (tab.code && reload) tab.code.setText(f.text);
        else {
          tab.el.replaceChildren();
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
        }
        await this.refreshGit(tab, !reload);
      } else if (f.kind === "image") {
        if (tab.image && reload) tab.image.reload(tab.mtime);
        else {
          tab.code = undefined;
          tab.image = new ImageView(tab.path, tab.mtime, () => this.status());
          tab.el.replaceChildren(tab.image.el);
          if (tab.path.endsWith(".svg")) tab.el.prepend(this.viewToggle(tab, "View source", icons.code));
        }
      } else if (f.kind === "binary") {
        tab.code = undefined;
        tab.el.replaceChildren(await binaryView(tab.path, f.size));
      } else {
        tab.code = undefined;
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
      tab.code = undefined;
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
        onclick: () => {
          tab.asSource = !tab.asSource;
          tab.code = undefined;
          tab.image = undefined;
          void this.load(tab);
        },
      },
      h("span", { html: icon }),
      label,
    );
  }

  activate(tab: Tab) {
    if (this.active === tab) return;
    this.active = tab;
    this.body.replaceChildren(tab.el);
    tab.code?.schedule();
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
      if (next) this.activate(next);
      else {
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

  private disposeTab(tab: Tab) {
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
    for (const t of this.tabs) t.code?.setFontSize(px);
  }

  openFind() {
    this.active?.code?.openFind();
  }

  nextChange(dir: 1 | -1) {
    this.active?.code?.nextChange(dir);
  }

  goToLine(line: number) {
    this.active?.code?.revealLine(line - 1);
  }

  private status() {
    const t = this.active;
    if (!t) return this.onStatus(null);
    const s: StatusInfo = { path: t.path, kind: t.kind, size: t.size, truncated: t.truncated };
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
    if (t.image) {
      s.dims = t.image.dims;
      s.zoom = t.image.zoomLabel;
    }
    this.onStatus(s);
  }

  render() {
    for (const t of this.tabs) {
      const cls = ["tab"];
      if (t === this.active) cls.push("active");
      if (!t.pinned) cls.push("preview");
      if (t.deleted) cls.push("deleted");
      const g = this.git?.repo ? this.git.file(t.path) : null;
      if (g) cls.push(`git-${g.letter}`);
      t.tabEl.className = cls.join(" ");
      t.tabEl.title = g ? `${t.path} · ${g.label}` : t.path;
      t.tabEl.setAttribute("aria-selected", String(t === this.active));
      t.tabEl.innerHTML = `${fileIcon(t.path)}<span class="tab-name">${esc(basename(t.path))}</span><button class="tab-close" title="Close (${MOD}W)">${icons.close}</button>`;
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
      if (this.active.truncated) this.crumbs.append(h("span", { class: "pill warn" }, `showing first ${formatBytes(8 * 1024 * 1024)}`));
      if (this.active.deleted) this.crumbs.append(h("span", { class: "pill warn" }, "deleted on disk"));
    }
    this.el.classList.toggle("has-tabs", this.tabs.length > 0);
    this.onChange();
  }

  serialize() {
    return { tabs: this.tabs.filter((t) => t.pinned).map((t) => t.path), active: this.active?.path ?? null };
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
