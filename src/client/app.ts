import { wsUrl } from "./auth.ts"; // first: installs the auth header on fetch
import { api, type Info } from "./api.ts";
import { Editor, type StatusInfo } from "./editor.ts";
import { FileTree } from "./tree.ts";
import { Palette, type Command, type PickItem } from "./palette.ts";
import { markdownToggleCommand } from "./mdcommands.ts";
import { TerminalPanel } from "./terminals.ts";
import type { Theme } from "./term/renderer.ts";
import { icons } from "./icons.ts";
import { GitState, relativeTime } from "./git.ts";
import { Updates } from "./updates.ts";
import { basename, debounce, dragSplitter, esc, formatBytes, h, IS_MAC, key, MOD, store } from "./util.ts";
import { Help } from "./help.ts";
import { isContextMenuOpen } from "./menu.ts";
import { SearchView } from "./search.ts";
import { ChangesView } from "./changes.ts";
import type { ChangeFile } from "./api.ts";
import { helpKey, normSideView, referenceKey, searchKey, symbolKey, type SideView } from "./keys.ts";
import { reference, referenceWithCode, unsafePath } from "./reference.ts";
import { headingText } from "./symbols.ts";
import { slugify } from "./markdown.ts";

type ThemeName = "dark" | "light" | "system";

interface Layout {
  sidebar: boolean;
  sidebarWidth: number;
  panel: boolean;
  panelPos: "bottom" | "right";
  panelSize: { bottom: number; right: number };
  maximized: boolean;
  theme: ThemeName;
  codeSize: number;
  termSize: number;
  sideView: SideView;
}

/** Panel decision (DESIGN.md §7): 13px on HiDPI screens, 14px on 1× screens. */
const BASE_SIZE = window.devicePixelRatio >= 2 ? 13 : 14;
const CODE_LINE_HEIGHT = 1.6;
const TERM_LINE_HEIGHT = 1.2;
const LAYOUT_VERSION = 2;

const DEFAULTS: Layout = {
  sidebar: true,
  sidebarWidth: 260,
  panel: true,
  panelPos: "bottom",
  panelSize: { bottom: 300, right: 560 },
  maximized: false,
  theme: "system",
  codeSize: BASE_SIZE,
  termSize: BASE_SIZE,
  sideView: "explorer",
};

/** Message channel to Codeviewer.app (WKWebView); undefined in a regular browser. */
const nativeBridge = () =>
  (window as unknown as { webkit?: { messageHandlers?: { native?: { postMessage(m: unknown): void } } } }).webkit?.messageHandlers?.native;

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function terminalTheme(): Theme {
  return {
    fg: cssVar("--term-fg"),
    bg: cssVar("--term-bg"),
    cursor: cssVar("--term-cursor"),
    cursorText: cssVar("--term-bg"),
    selection: cssVar("--term-selection"),
    link: cssVar("--accent"),
    ansi: Array.from({ length: 16 }, (_, i) => cssVar(`--ansi-${i}`)),
  };
}

const SYM_LETTER: Record<string, string> = { function: "ƒ", class: "C", type: "T", variable: "v", heading: "#", section: "§" };

class App {
  private L: Layout = { ...DEFAULTS };
  private info!: Info;
  private tree!: FileTree;
  private search!: SearchView;
  private changes!: ChangesView;
  private sideTabs = new Map<SideView, HTMLElement>();
  private sideTools!: HTMLElement;
  private editor!: Editor;
  private palette = new Palette();
  private terms!: TerminalPanel;
  private workbench!: HTMLElement;
  private sidebar!: HTMLElement;
  private main!: HTMLElement;
  private status!: HTMLElement;
  private statusRight!: HTMLElement;
  private themeBtn!: HTMLButtonElement;
  private live!: HTMLElement;
  private killArmed = 0;
  private help = new Help();
  private sideSplit!: HTMLElement;
  private panelSplit!: HTMLElement;
  private toast!: HTMLElement;
  private recent: string[] = [];
  private git = new GitState();
  private updates = new Updates();
  private lastStatus: StatusInfo | null = null;

  async start() {
    await store.init();
    const saved = store.get<Partial<Layout> & { v?: number }>("layout", {});
    // Older layouts carried pre-panel font sizes; let the new defaults apply.
    if (saved.v !== LAYOUT_VERSION) {
      delete saved.codeSize;
      delete saved.termSize;
    }
    this.L = { ...DEFAULTS, ...saved };
    this.L.sideView = normSideView(this.L.sideView);
    this.recent = store.get("recent", []);
    this.applyTheme();
    // The terminal measures its cell grid once, so the real faces must be loaded first.
    const faces = Promise.all(
      ["400", "700", "italic 400", "italic 700"].map((w) => document.fonts.load(`${w} ${BASE_SIZE}px "JetBrains Mono"`)),
    ).then(() => document.fonts.load(`13px "Inter"`));
    const loaded = await Promise.race([faces.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    this.info = await api.info();
    document.title = `${this.info.name} · codeviewer`;
    this.build();
    // Faces that arrive after the wait: re-measure the terminals. They repaint only rows whose
    // cells change, so a row drawn in the fallback font would otherwise stay that way.
    if (!loaded) void faces.then(() => this.terms.setFont(cssVar("--font-mono"), this.L.termSize, TERM_LINE_HEIGHT), () => {});
    this.tree.git = this.git;
    this.editor.git = this.git;
    this.git.onChange(() => {
      this.tree.onGitChanged();
      this.editor.onGitChanged();
      this.changes.setRepo(this.git.repo);
      this.changes.onGitChanged();
      this.renderStatus(this.lastStatus);
    });
    await api.gitStatus().then((s) => this.git.set(s), () => {});
    this.changes.setRepo(this.git.repo);
    await this.tree.init();
    this.bindKeys();
    this.connectEvents();
    this.terms.restore();
    if (!this.L.panel) this.terms.setShown(false);
    // Restore pinned tabs from last session.
    const tabs = store.get<{ tabs: string[]; active: string | null }>(`tabs:${this.info.root}`, { tabs: [], active: null });
    for (const p of tabs.tabs) await this.editor.open(p, { pin: true, focus: false });
    if (tabs.active) await this.editor.open(tabs.active, { focus: false });
    this.editor.onChange = () => {
      store.set(`tabs:${this.info.root}`, this.editor.serialize());
      this.changes.watching = this.editor.tabs.some((t) => t.isDiff && !t.commit);
    };
  }

  private build() {
    const L = this.L;
    // Title bar
    this.themeBtn = h("button", { class: "icon-btn", title: "Toggle theme", onclick: () => this.cycleTheme() });
    const search = h(
      "button",
      { class: "omnibox", onclick: () => this.palette.open() },
      h("span", { html: icons.search }),
      h("span", { class: "omni-text" }, `Search files in ${this.info.name}`),
      h("kbd", null, `${MOD}P`),
    );
    const titlebar = h(
      "header",
      { class: "titlebar" },
      h("div", { class: "brand" }, h("span", { class: "logo", html: icons.logo }), h("span", { class: "brand-name" }, this.info.name)),
      search,
      h(
        "div",
        { class: "title-actions" },
        h("button", { class: "icon-btn", title: `Toggle sidebar (${MOD}B)`, html: icons.sidebar, onclick: () => this.toggleSidebar() }),
        h("button", { class: "icon-btn", title: `Toggle terminal (${IS_MAC ? "⌃`" : "Ctrl+`"})`, html: icons.terminal, onclick: () => this.togglePanel() }),
        this.themeBtn,
      ),
    );

    // Codeviewer.app has no system title bar: empty parts of ours move/zoom the window.
    const native = nativeBridge();
    if (native) {
      titlebar.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, a, kbd")) return;
        e.preventDefault();
        native.postMessage({ t: e.detail >= 2 ? "dblclick" : "drag" });
      });
    }

    // Sidebar
    this.tree = new FileTree(this.info.name);
    this.tree.onOpen = (p, pin) => void this.openFile(p, { pin, focus: pin });
    this.search = new SearchView();
    this.tree.onSearchIn = (dir, ignored) => this.search.searchIn(dir, ignored);
    this.tree.onViewChanges = (p) => void this.viewChanges(p);
    this.tree.onHistory = (p) => void this.fileHistory(p);
    this.search.onReveal = () => this.showSearch();
    this.search.onOpen = (path, line, col, len) => void this.openFile(path, { line, col, len, focus: false });
    this.changes = new ChangesView();
    this.changes.onOpen = (f, pin) => void this.openDiff(f, pin);
    this.changes.onData = (d) => {
      this.editor.refreshDiffs({ rev: d?.rev ?? null, vs: this.changes.vs }, this.changes.files);
      this.editor.setDiffPositions((p) => this.changes.position(p));
    };
    const sideTab = (v: SideView, label: string) => {
      const b = h("button", { class: "side-tab", type: "button", onclick: () => this.setSideView(v) }, label);
      this.sideTabs.set(v, b);
      return b;
    };
    this.sideTools = h(
      "span",
      { class: "side-tools" },
      h("button", { class: "icon-btn sm", title: "Collapse all", html: icons.collapse, onclick: () => this.tree.collapseAll() }),
      h("button", { class: "icon-btn sm", title: "Clear change markers", html: icons.refresh, onclick: () => this.tree.clearChanges() }),
    );
    this.sidebar = h(
      "aside",
      { class: "sidebar" },
      h("div", { class: "side-head" }, sideTab("explorer", "Explorer"), sideTab("search", "Search"), sideTab("changes", "Changes"), h("span", { class: "side-title" }), this.sideTools),
      this.tree.el,
      this.search.el,
      this.changes.el,
    );
    this.setSideView(this.L.sideView, false);
    const sideSplit = (this.sideSplit = h("div", { class: "splitter vertical", role: "separator", "aria-label": "Sidebar width" }));

    // Editor
    const kb = (k: string, label: string) => h("div", { class: "kb-row" }, h("span", null, label), h("kbd", null, k));
    const welcome = h(
      "div",
      { class: "welcome" },
      h("div", { class: "welcome-logo", html: icons.logo }),
      h("h1", null, this.info.name),
      h("p", { class: "welcome-sub" }, this.info.root),
      h(
        "div",
        { class: "kb" },
        kb(`${MOD}P`, "Go to file"),
        kb(key("⌘⇧P", "Ctrl+Shift+P"), "Commands"),
        kb(key("⌃`", "Ctrl+`"), "Toggle terminal"),
        kb(`${MOD}F`, "Find in file"),
        kb(key("⌘⇧F", "Ctrl+Shift+F"), "Search in files"),
        kb("F4", "Next search result"),
        kb(key("⌃G", "Ctrl+G"), "Go to line"),
        kb(key("⌘⇧G", "Ctrl+Shift+G"), "Changes"),
        kb(`${MOD}B`, "Toggle sidebar"),
        kb(key("⌘/", "Ctrl+/"), "All shortcuts and tips"),
      ),
      h("p", { class: "welcome-hint" }, "Tip: run ", h("code", null, "codeviewer open <file>:<line>"), " in the terminal, or ", h("kbd", null, IS_MAC ? "⌘" : "Ctrl"), "-click a path."),
    );
    this.editor = new Editor(welcome);
    this.editor.fontSize = L.codeSize;
    this.editor.onActive = (t) => {
      this.tree.setActive(t?.path ?? null);
      if (t) this.trackRecent(t.path);
    };
    this.editor.onStatus = (s) => this.renderStatus(s);
    this.editor.onOpenLink = async (p, hash) => {
      const type = await api.stat(p);
      if (type === "file") {
        await this.openFile(p, { pin: true });
        if (hash) this.editor.revealFragment(p, hash);
        return true;
      }
      if (type === "dir") {
        if (!this.L.sidebar) this.toggleSidebar(true);
        await this.tree.reveal(p + "/");
        return true;
      }
      return false;
    };
    this.editor.onDiffStep = (dir) => this.changes.step(dir);
    this.editor.onReveal = (p) => {
      if (!L.sidebar) this.toggleSidebar();
      void this.tree.reveal(p);
    };

    // Terminal panel
    const mono = cssVar("--font-mono");
    this.terms = new TerminalPanel(
      terminalTheme,
      { family: mono, size: L.termSize, lineHeight: TERM_LINE_HEIGHT },
      this.info.shell,
      {
        togglePosition: () => this.setPanelPos(L.panelPos === "bottom" ? "right" : "bottom"),
        toggleMaximize: () => this.toggleMaximize(),
        hide: () => this.togglePanel(false),
      },
      (p, line) => void this.openFromTerminal(p, line),
      (url) => void api.external(url),
    );
    const panelSplit = (this.panelSplit = h("div", { class: "splitter panel-split", role: "separator", "aria-label": "Terminal panel size", tabindex: "0" }));

    this.main = h("div", { class: "main" }, this.editor.el, panelSplit, this.terms.el);
    this.workbench = h("div", { class: "workbench" }, this.sidebar, sideSplit, this.main);

    // Status bar
    this.status = h("div", { class: "status-left" });
    this.statusRight = h("div", { class: "status-right" });
    const statusbar = h("footer", { class: "statusbar" }, this.status, this.statusRight);

    this.toast = h("div", { class: "toast", hidden: true });
    this.live = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
    window.addEventListener("cv-toast", (e) => this.notify((e as CustomEvent<string>).detail));
    // Updates: launch check result, the Mac app's menu item, and its native restart.
    this.updates.onInfo = () => this.renderStatus(this.lastStatus);
    if (native) this.updates.nativeRelaunch = () => native.postMessage({ t: "relaunch" });
    window.addEventListener("cv-check-updates", () => void this.updates.checkNow());
    void this.updates.load().then(() => {
      const u = this.updates.info;
      if (u?.available && store.get<string>("updates.notified", "") !== u.latest) {
        store.set("updates.notified", u.latest);
        this.notify(`Codeviewer ${u.latest} is available: click "Update" in the status bar`);
      }
    });
    document.body.replaceChildren(titlebar, this.workbench, statusbar, this.palette.el, this.updates.el, this.help.el, this.toast, this.live);
    // Closing the window takes every terminal down: ask first while a program is running in one.
    window.addEventListener("beforeunload", (e) => {
      if (!this.terms.busy) return;
      e.preventDefault();
      e.returnValue = "";
    });

    // Splitters
    dragSplitter(sideSplit, "x", () => L.sidebarWidth, (s, d) => {
      L.sidebarWidth = Math.max(160, Math.min(640, s + d));
      this.applyLayout();
    });
    panelSplit.addEventListener("pointerdown", (e) => {
      // Axis depends on the current panel position, so handle drag manually.
      const axis = L.panelPos === "bottom" ? "y" : "x";
      const origin = axis === "y" ? e.clientY : e.clientX;
      const start = L.panelSize[L.panelPos];
      const mainRect = this.main.getBoundingClientRect();
      const max = (axis === "y" ? mainRect.height : mainRect.width) - 120;
      const move = (ev: PointerEvent) => {
        const delta = origin - (axis === "y" ? ev.clientY : ev.clientX);
        L.panelSize[L.panelPos] = Math.max(120, Math.min(max, start + delta));
        this.applyLayout();
      };
      const up = () => {
        panelSplit.removeEventListener("pointermove", move);
        panelSplit.removeEventListener("pointerup", up);
        document.body.classList.remove("resizing-x", "resizing-y");
      };
      e.preventDefault();
      panelSplit.setPointerCapture(e.pointerId);
      document.body.classList.add(axis === "y" ? "resizing-y" : "resizing-x");
      panelSplit.addEventListener("pointermove", move);
      panelSplit.addEventListener("pointerup", up);
    });
    panelSplit.addEventListener("keydown", (e) => {
      // Towards the editor shrinks the panel, away from it grows it, 16px per press.
      const grow = L.panelPos === "bottom" ? "ArrowUp" : "ArrowLeft";
      const shrink = L.panelPos === "bottom" ? "ArrowDown" : "ArrowRight";
      if (e.key !== grow && e.key !== shrink) return;
      e.preventDefault();
      const mainRect = this.main.getBoundingClientRect();
      const max = (L.panelPos === "bottom" ? mainRect.height : mainRect.width) - 120;
      L.panelSize[L.panelPos] = Math.max(120, Math.min(max, L.panelSize[L.panelPos] + (e.key === grow ? 16 : -16)));
      this.applyLayout();
    });

    this.palette.recent = this.recent;
    this.palette.onOpenFile = (p, line) => void this.openFile(p, { pin: true, line });
    this.palette.onGoToLine = (n) => this.editor.goToLine(n);
    this.palette.symbols = () => this.symbolItems();
    this.palette.commands = this.commands();

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme());
    this.applyLayout();
    this.applyTheme();
    this.renderStatus(null);
  }

  private commands(): Command[] {
    const c = (id: string, label: string, run: () => void, keys?: string): Command => ({ id, label, run, keys });
    return [
      c("term.toggle", "Toggle Terminal", () => this.togglePanel(), key("⌃` · ⌘J", "Ctrl+` · Ctrl+J")),
      c("term.new", "New Terminal", () => this.newTerminal(), IS_MAC ? "⌃⇧`" : "Ctrl+Shift+`"),
      c("term.kill", "Kill Active Terminal", () => this.terms.close()),
      c("term.next", "Next Terminal", () => this.terms.cycle(1), key("⌘⇧] in terminal", "Ctrl+Shift+] in terminal")),
      c("term.prev", "Previous Terminal", () => this.terms.cycle(-1), key("⌘⇧[ in terminal", "Ctrl+Shift+[ in terminal")),
      c("term.pos", "Move Terminal Panel (Bottom/Right)", () => this.setPanelPos(this.L.panelPos === "bottom" ? "right" : "bottom")),
      c("term.max", "Maximize/Restore Terminal Panel", () => this.toggleMaximize()),
      c("term.clear", "Clear Terminal", () => this.terms.active?.view.clear()),
      c("view.sidebar", "Toggle Sidebar", () => this.toggleSidebar(), `${MOD}B`),
      c("view.theme", "Cycle Theme (System/Dark/Light)", () => this.cycleTheme()),
      c("view.zoomIn", "Increase Font Size", () => this.zoom(1), `${MOD}=`),
      c("view.zoomOut", "Decrease Font Size", () => this.zoom(-1), `${MOD}-`),
      c("view.zoomReset", "Reset Font Size", () => this.zoom(0), `${MOD}0`),
      c("search.files", "Search in Files", () => this.showSearch(), IS_MAC ? "⌘⇧F" : "Ctrl+Shift+F"),
      c("search.next", "Next Search Result", () => this.search.step(1), "F4"),
      c("search.prev", "Previous Search Result", () => this.search.step(-1), key("⇧F4", "Shift+F4")),
      c("view.explorer", "Show Explorer", () => this.setSideView("explorer")),
      markdownToggleCommand({ isMarkdownTab: () => this.editor.isMarkdownTab(), toggleMarkdown: () => this.editor.toggleMarkdown() }),
      c("file.find", "Find in File", () => this.editor.openFind(), `${MOD}F`),
      c("file.line", "Go to Line…", () => this.palette.open(":"), IS_MAC ? "⌃G" : "Ctrl+G"),
      c("file.symbol", "Go to Symbol in File…", () => this.palette.open("@"), key("⌘⇧O", "Ctrl+Shift+O")),
      c("file.reference", "Copy Reference (path:line)", () => this.copyReference(false), key("⌥⌘C", "Ctrl+Alt+C")),
      c("file.referenceCode", "Copy Reference with Code", () => this.copyReference(true)),
      c("term.reference", "Insert Reference in Terminal", () => this.referenceToTerminal()),
      c("file.reveal", "Reveal Active File in Explorer", () => this.editor.active && void this.tree.reveal(this.editor.active.path)),
      c("file.copyPath", "Copy Path of Active File", () => this.copyPath(false)),
      c("file.copyAbs", "Copy Absolute Path of Active File", () => this.copyPath(true)),
      c("file.close", "Close Tab", () => this.editor.close(), IS_MAC ? "⌘W" : "Ctrl+W"),
      c("file.next", "Next Tab", () => this.editor.cycle(1), key("⌘⇧] · ⌃Tab", "Ctrl+Shift+] · Ctrl+Tab")),
      c("file.prev", "Previous Tab", () => this.editor.cycle(-1), key("⌘⇧[ · ⌃⇧Tab", "Ctrl+Shift+[ · Ctrl+Shift+Tab")),
      c("file.closeAll", "Close All Tabs", () => this.editor.closeAll()),
      c("tree.collapse", "Collapse All Folders", () => this.tree.collapseAll()),
      c("tree.clear", "Clear Change Markers", () => this.tree.clearChanges()),
      c("tree.focus", "Focus Explorer", () => this.tree.focus(), key("⌘⇧E", "Ctrl+Shift+E")),
      c("git.changes", "Git: Show Changes", () => this.showChanges(), key("⌘⇧G", "Ctrl+Shift+G")),
      c("git.peek", "Git: Peek HEAD on Current Line", () => {
        const code = this.editor.active?.code;
        if (!code) this.notify("Open a file first");
        else if (!code.peekCurrent()) this.notify("No change on this line");
      }),
      c("app.help", "Help: Keyboard Shortcuts & Tips", () => this.help.open(), key("⌘/", "Ctrl+/")),
      c("git.history", "Git: File History", () => {
        const t = this.editor.active;
        if (!t) this.notify("Open a file first");
        else void this.fileHistory(t.path);
      }),
      c("git.scope", "Git: Compare With Base Branch / HEAD", () => this.changes.toggleScope()),
      c("app.update", "Check for Updates…", () => void this.updates.checkNow()),
      c("app.autoUpdate", "Toggle Automatic Update Checks", () => {
        const auto = !(store.get<{ auto?: boolean }>("updates", {}).auto ?? true);
        store.set("updates", { auto });
        this.notify(`Automatic update checks ${auto ? "on" : "off"} (from the next launch)`);
      }),
      c("git.next", "Git: Next Change", () => this.editor.nextChange(1), key("⌥F5", "Alt+F5")),
      c("git.prev", "Git: Previous Change", () => this.editor.nextChange(-1), key("⌥⇧F5", "Alt+Shift+F5")),
    ];
  }

  // ───────────────────────────── actions ─────────────────────────────

  private async openFile(path: string, opts: { pin?: boolean; line?: number; col?: number; len?: number; focus?: boolean } = {}) {
    await this.editor.open(path, opts);
    void this.tree.reveal(path);
  }

  private async openFromTerminal(p: string, line: number) {
    let rel = p;
    if (rel.startsWith(this.info.root + "/")) rel = rel.slice(this.info.root.length + 1);
    rel = rel.replace(/^\.\//, "");
    // git diff prefixes (a/foo, b/foo) are tried as a fallback.
    const candidates = [rel, rel.replace(/^[ab]\//, "")];
    for (const c of candidates) {
      if (c.startsWith("/") || c.startsWith("~")) break;
      const type = await api.stat(c);
      if (type === "file") {
        await this.openFile(c, { pin: true, line, focus: false });
        return;
      }
      if (type === "dir") {
        if (!this.L.sidebar) this.toggleSidebar(true);
        await this.tree.reveal(c + "/");
        return;
      }
    }
    this.notify(`Not found in ${this.info.name}: ${p}`);
  }

  /** ⌘⇧G: the Changes view, focused on the list. */
  private showChanges() {
    if (!this.git.repo) return this.notify("Not a git repository");
    if (!this.L.sidebar) this.toggleSidebar(true);
    this.setSideView("changes");
    this.changes.focus();
  }

  private async openDiff(f: ChangeFile, pin: boolean, focus = false) {
    const d = this.changes.data;
    await this.editor.openDiff(f, { rev: d?.rev ?? null, vs: this.changes.vs }, { pin, focus });
    this.changes.setCurrent(f.path);
    this.editor.setDiffPositions((p) => this.changes.position(p));
  }

  /**
   * "View Changes" on an explorer file: the Changes view with the file's diff open and focused (a
   * preview tab, like a click in the list). The list is brought up to date first: the view may have
   * been hidden and stale, and its own refresh may still be in flight.
   */
  private async viewChanges(path: string) {
    if (!this.git.repo) return this.notify("Not a git repository");
    if (!this.L.sidebar) this.toggleSidebar(true);
    this.setSideView("changes");
    await this.changes.ready();
    const f = this.changes.files.find((x) => x.path === path);
    if (!f) return this.notify(`No changes in ${basename(path)} ${this.changes.vs}`);
    await this.openDiff(f, false, true);
  }

  /** "@" in the palette: the active file's outline, indented by nesting. */
  private symbolItems(): PickItem[] | string {
    const o = this.editor.outline();
    if (typeof o === "string") return o;
    const depths = [...new Set(o.syms.map((s) => s.depth))].sort((a, b) => a - b);
    const seen = new Map<string, number>();
    return o.syms.map((s) => {
      // Headings get the same slugs as the preview's ids, repeats included.
      const slug = s.kind === "heading" ? slugify(headingText(s.name), seen) : undefined;
      return {
        label: s.name,
        detail: `${s.kind} · line ${s.line + 1}`,
        icon: `<span class="sym-kind sym-${s.kind}" aria-hidden="true">${SYM_LETTER[s.kind]}</span>`,
        indent: depths.indexOf(s.depth),
        run: () => this.editor.revealSymbol(s, slug),
      };
    });
  }

  /** Commits that changed `path`, newest first; picking one opens what it changed. */
  private async fileHistory(path: string) {
    if (!this.git.repo) return this.notify("Not a git repository");
    const list = await api.gitHistory(path);
    if (!list?.length) return this.notify(`No history for ${basename(path)}`);
    const items: PickItem[] = list.map((c) => ({
      label: c.subject || "(no subject)",
      detail: `${c.oid.slice(0, 7)} · ${c.author} · ${relativeTime(c.time)}${c.oldPath && c.oldPath !== c.path ? ` · from ${c.oldPath}` : ""}`,
      icon: `<span class="gbadge git-${c.status}">${c.status}</span>`,
      run: () => void this.editor.openCommitDiff(c, { focus: true }),
    }));
    this.palette.pick(items, `History of ${basename(path)}: ${list.length}${list.length >= 500 ? "+" : ""} commit${list.length === 1 ? "" : "s"}, type to filter`);
  }

  private copyReference(withCode: boolean) {
    const r = this.editor.referenceTarget();
    if (typeof r === "string") return this.notify(r);
    if (unsafePath(r.path)) return this.notify("This file name has control characters: no reference copied");
    const text = withCode && r.span && r.lines ? referenceWithCode(r.path, r.span, r.lines) : reference(r.path, r.span);
    void navigator.clipboard.writeText(text);
    this.notify(`Copied ${reference(r.path, r.span)}${withCode && r.span ? " with code" : ""}`);
  }

  /** Types the reference at the active terminal's prompt (as a paste, never with Enter). */
  private referenceToTerminal() {
    const r = this.editor.referenceTarget();
    if (typeof r === "string") return this.notify(r);
    if (unsafePath(r.path)) return this.notify("This file name has control characters: nothing inserted");
    const term = this.terms.active;
    if (!term || this.terms.activeExited) return this.notify("No running terminal to insert into");
    if (!this.L.panel) this.togglePanel(true);
    term.view.paste(`${reference(r.path, r.span)} `);
    this.terms.focus();
  }

  private trackRecent(p: string) {
    this.recent = [p, ...this.recent.filter((x) => x !== p)].slice(0, 30);
    this.palette.recent = this.recent;
    store.set("recent", this.recent);
  }

  private copyPath(abs: boolean) {
    const t = this.editor.active;
    if (!t) return;
    void navigator.clipboard.writeText(abs ? `${this.info.root}/${t.path}` : t.path);
    this.notify("Path copied");
  }

  private setSideView(v: SideView, save = true) {
    this.L.sideView = v;
    this.tree.el.hidden = v !== "explorer";
    this.search.el.hidden = v !== "search";
    this.changes.el.hidden = v !== "changes";
    if (v === "search") this.search.onShown();
    if (v === "changes") this.changes.onShown();
    else this.changes.onHidden();
    this.sideTools.hidden = v !== "explorer";
    for (const [k, b] of this.sideTabs) {
      b.classList.toggle("active", k === v);
      b.setAttribute("aria-pressed", String(k === v));
    }
    if (save) this.saveLayout();
  }

  private showSearch() {
    if (!this.L.sidebar) this.toggleSidebar(true);
    this.setSideView("search");
    this.search.focus();
  }

  private toggleSidebar(on = !this.L.sidebar) {
    this.L.sidebar = on;
    this.applyLayout();
  }

  private togglePanel(on = !this.L.panel) {
    this.L.panel = on;
    if (on && this.terms.count === 0) this.terms.create();
    this.terms.setShown(on);
    if (!on && this.L.maximized) this.L.maximized = false;
    this.applyLayout();
    if (on) requestAnimationFrame(() => this.terms.focus());
    else this.editor.active?.code?.focus();
  }

  private newTerminal() {
    if (!this.L.panel) this.togglePanel(true);
    this.terms.create();
  }

  private setPanelPos(pos: "bottom" | "right") {
    this.L.panelPos = pos;
    this.applyLayout();
  }

  private toggleMaximize() {
    this.L.maximized = !this.L.maximized;
    if (this.L.maximized && !this.L.panel) this.togglePanel(true);
    this.applyLayout();
  }

  private zoom(d: number) {
    const L = this.L;
    if (d === 0) {
      L.codeSize = DEFAULTS.codeSize;
      L.termSize = DEFAULTS.termSize;
    } else {
      L.codeSize = Math.max(9, Math.min(28, L.codeSize + d));
      L.termSize = Math.max(9, Math.min(28, L.termSize + d));
    }
    this.editor.setFontSize(L.codeSize);
    this.terms.setFont(cssVar("--font-mono"), L.termSize, TERM_LINE_HEIGHT);
    this.applyUiScale();
    this.saveLayout();
  }

  /** The chrome (sidebar, tabs, status bar, palette) follows the code size, so zooming scales everything. */
  private applyUiScale() {
    document.documentElement.style.setProperty("--ui-scale", (this.L.codeSize / BASE_SIZE).toFixed(3));
  }

  private cycleTheme() {
    const order: ThemeName[] = ["system", "dark", "light"];
    this.L.theme = order[(order.indexOf(this.L.theme) + 1) % order.length]!;
    this.applyTheme();
    this.notify(`Theme: ${this.L.theme}`);
    this.saveLayout();
  }

  private applyTheme() {
    const t = this.L.theme;
    const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    // Codeviewer.app: match the native window (traffic lights, background) to the theme.
    nativeBridge()?.postMessage({ t: "theme", dark, bg: cssVar("--bg") });
    if (this.themeBtn) {
      this.themeBtn.innerHTML = dark ? icons.moon : icons.sun;
      this.themeBtn.title = `Theme: ${t} (click to change)`;
    }
    this.terms?.setTheme(terminalTheme());
  }

  private applyLayout() {
    const L = this.L;
    const wb = this.workbench;
    wb.style.setProperty("--sidebar-w", `${L.sidebarWidth}px`);
    this.sideSplit.setAttribute("aria-valuenow", String(L.sidebarWidth));
    this.panelSplit.setAttribute("aria-valuenow", String(L.panelSize[L.panelPos]));
    this.panelSplit.setAttribute("aria-orientation", L.panelPos === "bottom" ? "horizontal" : "vertical");
    this.applyUiScale();
    wb.style.setProperty("--panel-h", `${L.panelSize.bottom}px`);
    wb.style.setProperty("--panel-w", `${L.panelSize.right}px`);
    wb.classList.toggle("no-sidebar", !L.sidebar);
    wb.classList.toggle("no-panel", !L.panel);
    wb.classList.toggle("panel-right", L.panelPos === "right");
    wb.classList.toggle("panel-max", L.maximized && L.panel);
    this.terms.updateButtons(L.panelPos, L.maximized);
    this.saveLayout();
  }

  private saveLayout = debounce(() => store.set("layout", { ...this.L, v: LAYOUT_VERSION }), 200);

  private notify(msg: string) {
    this.live.textContent = msg; // announced by screen readers
    this.toast.textContent = msg;
    this.toast.hidden = false;
    this.toast.classList.remove("show");
    void this.toast.offsetWidth;
    this.toast.classList.add("show");
    clearTimeout((this.toast as unknown as { t: number }).t);
    (this.toast as unknown as { t: number }).t = window.setTimeout(() => (this.toast.hidden = true), 2200);
  }

  private renderStatus(s: StatusInfo | null) {
    this.lastStatus = s;
    // The text sits in its own span so a long path gets an ellipsis (flex items don't ellipsize bare text).
    const item = (text: string, title = "") => h("span", { class: "st-item", title }, h("span", { class: "st-text" }, text));
    const left: HTMLElement[] = [h("span", { class: "st-item st-root", title: this.info.root }, h("span", { class: "st-dot live" }), this.info.name)];
    const g = this.git.status;
    if (g.repo) {
      const name = g.branch ?? (g.oid ? g.oid.slice(0, 7) : "no commits");
      const tip = [
        g.detached ? `Detached HEAD at ${g.oid?.slice(0, 7)}` : `Branch ${g.branch}`,
        g.upstream ? `tracking ${g.upstream}` : "no upstream",
        g.head ? `last commit: ${g.head.subject} (${g.head.author}, ${relativeTime(g.head.time)})` : "",
      ].filter(Boolean).join("\n");
      const dirty = this.git.counts.changed + this.git.counts.untracked + this.git.counts.conflicts > 0;
      const branch = h("button", { class: "st-item st-git", title: tip, onclick: () => this.showChanges() });
      branch.innerHTML = `${icons.branch}<span>${esc(name)}${dirty ? "*" : ""}</span>`;
      if (g.behind || g.ahead) {
        branch.insertAdjacentHTML("beforeend", `<span class="st-ab">${g.behind ? `↓${g.behind}` : ""}${g.ahead ? `↑${g.ahead}` : ""}</span>`);
      }
      left.push(branch);
      if (g.state) left.push(h("span", { class: "st-item st-state", title: `A ${g.state.replace(/ing$/, "")} is in progress` }, g.state.toUpperCase()));
      const c = this.git.counts;
      if (dirty) {
        const parts: string[] = [];
        if (c.conflicts) parts.push(`<span class="git-C">${c.conflicts} conflict${c.conflicts === 1 ? "" : "s"}</span>`);
        if (c.changed) parts.push(`<span class="git-M">${c.changed} changed</span>`);
        if (c.untracked) parts.push(`<span class="git-U">${c.untracked} untracked</span>`);
        const changes = h("button", { class: "st-item", title: `${c.staged} staged · click to show Changes (${key("⌘⇧G", "Ctrl+Shift+G")})`, onclick: () => this.showChanges() });
        changes.innerHTML = parts.join('<span class="st-sep">·</span>');
        left.push(changes);
      }
      if (g.stash) {
        const st = h("span", { class: "st-item", title: `${g.stash} stash entr${g.stash === 1 ? "y" : "ies"}` });
        st.innerHTML = `${icons.stash}${g.stash}`;
        left.push(st);
      }
    }
    if (s) left.push(item(s.path));
    this.status.replaceChildren(...left);

    const right: HTMLElement[] = [];
    if (s) {
      if (s.git) right.push(h("span", { class: "st-item", title: "git status of this file" }, s.git));
      if (s.diff && (s.diff.added || s.diff.removed)) {
        const d = h("span", { class: "st-item st-diff", title: "Lines added / removed vs HEAD" });
        d.innerHTML = `<span class="git-A">+${s.diff.added}</span><span class="git-D">−${s.diff.removed}</span>`;
        right.push(d);
      }
      if (s.line) right.push(item(`Ln ${s.line}`));
      if (s.lines !== undefined) right.push(item(`${s.lines.toLocaleString()} lines`));
      if (s.dims) right.push(item(s.dims));
      if (s.zoom) right.push(item(s.zoom));
      if (s.size !== undefined) right.push(item(formatBytes(s.size)));
      if (s.eol) right.push(item(s.eol));
      if (s.kind === "text") right.push(item(s.encoding ?? "UTF-8"));
      if (s.lang) right.push(item(s.lang));
    }
    const u = this.updates.info;
    if (u?.available) {
      const b = h("button", { class: "st-item st-update", title: `Codeviewer ${u.latest} is available (you have ${u.current})`, onclick: () => this.updates.open() });
      b.innerHTML = `<span class="st-up">↑</span>Update ${u.latest}`;
      right.push(b);
    }
    right.push(h("span", { class: "st-item muted" }, "Read-only"));
    this.statusRight.replaceChildren(...right);
  }

  // ───────────────────────────── keys & events ─────────────────────────────

  private bindKeys() {
    window.addEventListener(
      "keydown",
      (e) => {
        if (isContextMenuOpen()) return; // its own listener takes the key
        const mod = IS_MAC ? e.metaKey : e.ctrlKey;
        const k = e.key.toLowerCase();
        const inTerm = (e.target as HTMLElement).classList?.contains("term-input");
        const inPalette = (e.target as HTMLElement).classList?.contains("palette-input");
        // On Linux the modifier is Ctrl, which terminal programs use heavily (^P history, ^W
        // delete word, ^_ undo…): plain Ctrl shortcuts stay out of a focused terminal there.
        const appKey = IS_MAC || !inTerm;
        let handled = true;
        const sk = searchKey(e, { isMac: IS_MAC, inTerm: !!inTerm });
        if (sk === "search") this.showSearch();
        else if (sk === "next" || sk === "prev") this.search.step(sk === "next" ? 1 : -1);
        else if (e.ctrlKey && (e.code === "Backquote" || k === "`")) {
          if (e.shiftKey) this.newTerminal();
          else if (this.L.panel && !inTerm) this.terms.focus();
          else this.togglePanel();
        } else if (mod && e.shiftKey && k === "g") this.showChanges();
        else if (symbolKey(e, { isMac: IS_MAC }) && appKey) this.palette.open("@");
        else if (referenceKey(e, { isMac: IS_MAC }) && !inTerm) this.copyReference(false);
        else if (e.altKey && e.key === "F5" && !inTerm) this.editor.nextChange(e.shiftKey ? -1 : 1);
        else if (mod && e.shiftKey && k === "p") this.palette.open(">");
        else if (mod && !e.shiftKey && k === "p" && appKey && (IS_MAC || !inPalette)) this.palette.open(); // Linux: Ctrl+P is the palette's own "up"
        else if (mod && e.shiftKey && k === "e") {
          if (!this.L.sidebar) this.toggleSidebar(true);
          this.tree.focus();
        } else if (mod && k === "b" && !inTerm) this.toggleSidebar();
        else if (mod && !e.shiftKey && k === "f" && !inTerm) this.editor.openFind();
        else if (e.ctrlKey && k === "g" && !inTerm) this.palette.open(":");
        else if (mod && k === "w" && !inTerm) this.editor.close();
        else if (mod && k === "w" && inTerm) {
          // Closing an exited terminal kills nothing. A live one (an agent may be running) needs
          // a second press; on Linux Ctrl+W belongs to the shell and the exited case is the only one.
          if (this.terms.activeExited) this.terms.close();
          else if (!IS_MAC) handled = false;
          else if (performance.now() - this.killArmed < 3000) {
            this.killArmed = 0;
            this.terms.close();
          } else {
            this.killArmed = performance.now();
            this.notify(`Press ${MOD}W again to kill this terminal`);
          }
        } else if (mod && e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) {
          const dir = e.code === "BracketRight" ? 1 : -1;
          if (inTerm) this.terms.cycle(dir);
          else this.editor.cycle(dir);
        }
        else if (e.ctrlKey && e.key === "Tab" && !inTerm) this.editor.cycle(e.shiftKey ? -1 : 1);
        else if (mod && (k === "=" || k === "+") && appKey) this.zoom(1);
        else if (mod && k === "-" && appKey) this.zoom(-1);
        else if (mod && k === "0" && appKey) this.zoom(0);
        else if (mod && k === "j" && !inTerm) this.togglePanel();
        else if (helpKey(e, { isMac: IS_MAC }) && appKey) this.help.open();
        else if (e.key === "Escape" && this.help.isOpen) this.help.close();
        else if (e.key === "Escape" && this.palette.isOpen) this.palette.close();
        else handled = false;
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
  }

  private connectEvents() {
    let retry = 500;
    const connect = () => {
      const ws = new WebSocket(wsUrl("/ws/events"));
      ws.onopen = () => {
        retry = 500;
        if (document.body.classList.contains("offline")) this.notify("Reconnected to codeviewer");
        document.body.classList.remove("offline");
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as {
          t: string; paths?: string[]; path?: string; line?: number; status?: unknown; many?: boolean; structural?: boolean;
        };
        if (msg.t === "changed" && msg.paths) {
          if (msg.structural) this.palette.invalidate();
          this.search.markStale(msg.paths, msg.many);
          if (msg.many) {
            void this.tree.reloadAll();
            this.editor.onChanged(this.editor.tabs.map((t) => t.path));
          } else {
            void this.tree.onChanged(msg.paths);
            this.editor.onChanged(msg.paths);
          }
        } else if (msg.t === "update") {
          const m = msg as unknown as { phase: string; detail?: string; relaunch?: "native" | "server" | "manual" };
          this.updates.onEvent(m.phase, m.detail, m.relaunch);
        } else if (msg.t === "git" && msg.status) {
          this.git.set(msg.status as never);
        } else if (msg.t === "open" && msg.path) {
          void this.openFile(msg.path, { pin: true, line: msg.line, focus: false });
          window.focus();
        }
      };
      ws.onclose = () => {
        if (!document.body.classList.contains("offline")) this.notify("Connection to codeviewer lost: reconnecting…");
        document.body.classList.add("offline");
        setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
      };
    };
    connect();
  }
}

new App().start().catch((e) => {
  document.body.replaceChildren(
    h("div", { class: "fatal" }, h("h1", null, "codeviewer"), h("p", null, String((e as Error).message)), h("p", null, "Open the URL codeviewer printed in your terminal (it carries the access token).")),
  );
});
