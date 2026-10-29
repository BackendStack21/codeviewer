import { api, type Entry } from "./api.ts";
import { chevron, fileIcon, folderIcon } from "./icons.ts";
import { dirname, esc, h, IS_MAC } from "./util.ts";
import { showContextMenu } from "./menu.ts";
import type { GitState } from "./git.ts";

interface TNode {
  name: string;
  path: string;
  type: Entry["type"];
  depth: number;
  link?: boolean;
  expanded: boolean;
  children: TNode[] | null;
  loading?: Promise<void>;
}

const ROW = 24;

/** Lazily loaded, virtualized file tree. */
export class FileTree {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private sizer: HTMLElement;
  private rows: HTMLElement;
  private root: TNode;
  private flat: TNode[] = [];
  private byPath = new Map<string, TNode>();
  private selected: string | null = null;
  private active: string | null = null;
  private changed = new Set<string>();
  private changedDirs = new Set<string>();
  private frame = 0;
  onOpen: (path: string, pin: boolean) => void = () => {};
  onSearchIn: (dir: string) => void = () => {};
  git: GitState | null = null;

  constructor(rootName: string) {
    this.root = { name: rootName, path: "", type: "dir", depth: -1, expanded: true, children: null };
    this.byPath.set("", this.root);
    this.rows = h("div", { class: "tree-rows", role: "tree" });
    this.sizer = h("div", { class: "tree-sizer" }, this.rows);
    this.scroller = h("div", { class: "tree-scroll", tabindex: "0" }, this.sizer);
    this.el = this.scroller;
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.scroller);
    this.rows.addEventListener("click", (e) => this.onClick(e as MouseEvent, false));
    this.rows.addEventListener("dblclick", (e) => this.onClick(e as MouseEvent, true));
    this.scroller.addEventListener("contextmenu", (e) => this.onContextMenu(e as MouseEvent));
    this.scroller.addEventListener("keydown", (e) => this.onKey(e));
  }

  async init() {
    await this.load(this.root);
    this.reflow();
  }

  private async load(node: TNode) {
    if (node.loading) return node.loading;
    node.loading = (async () => {
      try {
        const entries = await api.list(node.path);
        const old = new Map((node.children ?? []).map((c) => [c.name, c]));
        node.children = entries.map((e) => {
          const prev = old.get(e.name);
          if (prev && prev.type === e.type) return prev;
          const path = node.path ? `${node.path}/${e.name}` : e.name;
          const child: TNode = { name: e.name, path, type: e.type, depth: node.depth + 1, link: e.link, expanded: false, children: null };
          this.byPath.set(path, child);
          return child;
        });
        for (const [name, c] of old) if (!node.children.some((n) => n.name === name)) this.forget(c);
      } catch {
        node.children = node.children ?? [];
      } finally {
        node.loading = undefined;
      }
    })();
    return node.loading;
  }

  private forget(n: TNode) {
    this.byPath.delete(n.path);
    n.children?.forEach((c) => this.forget(c));
  }

  private reflow() {
    const out: TNode[] = [];
    const walk = (n: TNode) => {
      for (const c of n.children ?? []) {
        out.push(c);
        if (c.expanded && c.children) walk(c);
      }
    };
    walk(this.root);
    this.flat = out;
    this.sizer.style.height = `${out.length * ROW}px`;
    this.schedule();
  }

  /** Rendered row window; scrolling within it needs no DOM work. */
  private window = { first: 0, last: -1 };
  private stale = true;

  private schedule() {
    this.stale = true;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  private onScroll() {
    const top = this.scroller.scrollTop;
    const firstVisible = Math.floor(top / ROW);
    const lastVisible = Math.ceil((top + this.scroller.clientHeight) / ROW);
    if (firstVisible < this.window.first || lastVisible > this.window.last) {
      if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
    }
  }

  private render() {
    this.frame = 0;
    const top = this.scroller.scrollTop;
    const height = this.scroller.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW) - 30);
    const last = Math.min(this.flat.length, Math.ceil((top + height) / ROW) + 30);
    if (!this.stale && first >= this.window.first && last <= this.window.last) return;
    this.stale = false;
    this.window = { first, last: first === 0 && last === this.flat.length ? Infinity : last };
    let html = "";
    for (let i = first; i < last; i++) {
      const n = this.flat[i]!;
      const isDir = n.type === "dir";
      const cls = ["row", isDir ? "dir" : "file"];
      if (n.path === this.selected) cls.push("selected");
      if (n.path === this.active) cls.push("active");
      if (n.type === "link-broken") cls.push("broken");
      if (n.name.startsWith(".")) cls.push("hidden");
      const changed = isDir ? this.changedDirs.has(n.path) : this.changed.has(n.path);
      let gitBadge = "";
      let gitTitle = "";
      if (this.git?.repo) {
        if (isDir) {
          const l = this.git.dir(n.path);
          if (l) {
            cls.push(`git-${l}`);
            if (l !== "I") gitBadge = `<span class="gdot"></span>`;
          }
        } else {
          const g = this.git.file(n.path);
          if (g) {
            cls.push(`git-${g.letter}`);
            gitTitle = ` title="${esc(g.label)}"`;
            if (g.letter !== "I") gitBadge = `<span class="gbadge">${g.letter}</span>`;
          }
        }
      }
      const indent = n.depth * 12 + 8;
      html +=
        `<div class="${cls.join(" ")}" role="treeitem" data-i="${i}"${gitTitle} style="transform:translateY(${i * ROW}px);padding-left:${indent}px;--d:${n.depth}"` +
        (isDir ? ` aria-expanded="${n.expanded}"` : "") +
        `>` +
        (isDir ? `<span class="twisty${n.expanded ? " open" : ""}">${chevron}</span>${folderIcon(n.expanded)}` : `<span class="twisty"></span>${fileIcon(n.name)}`) +
        `<span class="name">${esc(n.name)}</span>` +
        (n.link ? `<span class="badge" title="symlink">↗</span>` : "") +
        (changed ? `<span class="dot" title="Changed on disk"></span>` : "") +
        gitBadge +
        `</div>`;
    }
    this.rows.innerHTML = html;
  }

  private onClick(e: MouseEvent, dbl: boolean) {
    if (IS_MAC && e.ctrlKey) return; // ⌃-click is the context menu there
    const row = (e.target as HTMLElement).closest<HTMLElement>(".row");
    if (!row) return;
    const n = this.flat[Number(row.dataset.i)];
    if (!n) return;
    this.selected = n.path;
    if (n.type === "dir") {
      if (!dbl) void this.toggle(n);
    } else if (n.type === "file") {
      this.onOpen(n.path, dbl);
    }
    this.schedule();
  }

  /** Our own menu instead of the WebView's (Reload, Inspect Element…), anywhere in the explorer. */
  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>(".row");
    const n = row && this.flat[Number(row.dataset.i)];
    const collapse = { label: "Collapse All", run: () => this.collapseAll() };
    if (!n) return showContextMenu(e, [collapse]);
    this.selected = n.path;
    this.schedule();
    if (n.type === "dir") {
      showContextMenu(e, [
        { label: n.expanded ? "Collapse" : "Expand", run: () => void this.toggle(n) },
        { label: "Search in Folder…", run: () => this.onSearchIn(n.path) },
        collapse,
      ]);
    } else if (n.type === "file") {
      showContextMenu(e, [{ label: "Open in New Tab", run: () => this.onOpen(n.path, true) }]);
    }
  }

  private async toggle(n: TNode, open = !n.expanded) {
    n.expanded = open;
    if (open && !n.children) {
      this.reflow();
      await this.load(n);
    }
    this.reflow();
  }

  private onKey(e: KeyboardEvent) {
    const idx = this.flat.findIndex((n) => n.path === this.selected);
    const n = this.flat[idx];
    const select = (i: number) => {
      const t = this.flat[Math.max(0, Math.min(this.flat.length - 1, i))];
      if (!t) return;
      this.selected = t.path;
      this.scrollTo(Math.max(0, Math.min(this.flat.length - 1, i)));
      this.schedule();
    };
    switch (e.key) {
      case "ArrowDown":
        select(idx + 1);
        break;
      case "ArrowUp":
        select(idx < 0 ? 0 : idx - 1);
        break;
      case "ArrowRight":
        if (n?.type === "dir") {
          if (!n.expanded) void this.toggle(n, true);
          else select(idx + 1);
        }
        break;
      case "ArrowLeft":
        if (n?.type === "dir" && n.expanded) void this.toggle(n, false);
        else if (n) {
          const parent = dirname(n.path);
          const pi = this.flat.findIndex((x) => x.path === parent);
          if (pi >= 0) select(pi);
        }
        break;
      case "Home":
        select(0);
        break;
      case "End":
        select(this.flat.length - 1);
        break;
      case "Enter":
      case " ":
        if (n?.type === "dir") void this.toggle(n);
        else if (n) this.onOpen(n.path, e.key === "Enter");
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  private scrollTo(i: number) {
    const top = i * ROW;
    const s = this.scroller;
    if (top < s.scrollTop) s.scrollTop = top;
    else if (top + ROW > s.scrollTop + s.clientHeight) s.scrollTop = top + ROW - s.clientHeight;
  }

  focus() {
    this.scroller.focus();
    if (!this.selected && this.flat[0]) {
      this.selected = this.flat[0].path;
      this.schedule();
    }
  }

  setActive(path: string | null) {
    this.active = path;
    if (path && this.changed.delete(path)) this.recomputeChangedDirs();
    this.schedule();
  }

  /** Expands all ancestors of `path` and scrolls it into view. */
  async reveal(path: string) {
    const parts = path.split("/");
    let cur = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur.children) await this.load(cur);
      const next = cur.children?.find((c) => c.name === parts[i]);
      if (!next || next.type !== "dir") break;
      next.expanded = true;
      if (!next.children) await this.load(next);
      cur = next;
    }
    this.reflow();
    path = path.replace(/\/$/, "");
    this.selected = path;
    const i = this.flat.findIndex((n) => n.path === path);
    if (i >= 0) {
      const s = this.scroller;
      const top = i * ROW;
      if (top < s.scrollTop || top > s.scrollTop + s.clientHeight - ROW) s.scrollTop = top - s.clientHeight / 3;
    }
    this.schedule();
  }

  collapseAll() {
    for (const n of this.byPath.values()) if (n !== this.root) n.expanded = false;
    this.reflow();
  }

  /** Called with paths reported by the file watcher. */
  /** After a huge burst of changes: reload every directory that is currently loaded. */
  async reloadAll() {
    const loaded = [...this.byPath.values()].filter((n) => n.type === "dir" && n.children);
    await Promise.all(loaded.map((n) => this.load(n)));
    this.reflow();
  }

  async onChanged(paths: string[]) {
    const dirs = new Set<string>();
    for (const p of paths) {
      dirs.add(dirname(p));
      const node = this.byPath.get(p);
      if (node?.type === "dir" && node.children) dirs.add(p);
      if (p !== this.active && (!node || node.type === "file") && !this.isIgnored(p)) this.changed.add(p);
    }
    // Bounded: a build can touch tens of thousands of files; keep the most recent ones.
    if (this.changed.size > 2000) {
      const keep = [...this.changed].slice(-2000);
      this.changed = new Set(keep);
    }
    await Promise.all([...dirs].map((d) => this.byPath.get(d)).filter((n): n is TNode => !!n?.children).map((n) => this.load(n)));
    // Only keep change dots for paths that still exist as files.
    for (const p of this.changed) {
      const n = this.byPath.get(p);
      const parent = this.byPath.get(dirname(p));
      if ((parent?.children && !n) || n?.type === "dir") this.changed.delete(p);
    }
    this.recomputeChangedDirs();
    this.reflow();
  }

  /**
   * Git status changed: files it just saw committed, reverted or ignored no longer count as
   * changes. Only that transition prunes: a status taken before a write would still call the
   * file clean, and the next one (showing it modified) wouldn't bring the marker back.
   */
  onGitChanged() {
    if (this.git?.repo) {
      let pruned = false;
      for (const p of this.changed) if (this.git.cleared(p)) pruned = this.changed.delete(p) || pruned;
      if (pruned) this.recomputeChangedDirs();
    }
    this.schedule();
  }

  /** Build output and the like: churn there isn't worth a marker. */
  private isIgnored(p: string) {
    return !!this.git?.repo && this.git.file(p)?.letter === "I";
  }

  clearChanges() {
    this.changed.clear();
    this.recomputeChangedDirs();
    this.schedule();
  }

  private recomputeChangedDirs() {
    this.changedDirs.clear();
    for (const p of this.changed) {
      let d = dirname(p);
      while (d) {
        this.changedDirs.add(d);
        d = dirname(d);
      }
    }
  }
}
