import { TerminalView } from "./term/view.ts";
import type { Theme } from "./term/renderer.ts";
import { icons } from "./icons.ts";
import { esc, h, local, MOD } from "./util.ts";
import { wsUrl } from "./auth.ts";

interface Session {
  id: string;
  title: string;
  view: TerminalView;
  ws: WebSocket | null;
  tabEl: HTMLElement;
  pending: Uint8Array[];
  exited: boolean;
  size: { cols: number; rows: number };
}

export interface PanelActions {
  togglePosition(): void;
  toggleMaximize(): void;
  hide(): void;
}

const enc = new TextEncoder();

function newId() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

/** Terminal panel: tabs of PTY sessions that survive page reloads. */
export class TerminalPanel {
  readonly el: HTMLElement;
  private tabsEl: HTMLElement;
  private body: HTMLElement;
  private sessions: Session[] = [];
  active: Session | null = null;
  private posBtn: HTMLButtonElement;
  private maxBtn: HTMLButtonElement;

  constructor(
    private theme: () => Theme,
    private font: { family: string; size: number; lineHeight: number },
    private shellName: string,
    private actions: PanelActions,
    private onOpenPath: (path: string, line: number) => void,
    private onOpenUrl: (url: string) => void,
  ) {
    this.tabsEl = h("div", { class: "term-tabs", role: "tablist" });
    const btn = (icon: string, title: string, fn: () => void) => h("button", { class: "icon-btn", title, html: icon, onclick: fn });
    this.posBtn = btn(icons.panelRight, "Move panel", () => actions.togglePosition());
    this.maxBtn = btn(icons.maximize, "Maximize panel", () => actions.toggleMaximize());
    const head = h(
      "div",
      { class: "panel-head" },
      h("div", { class: "panel-title" }, h("span", { html: icons.terminal }), "Terminal"),
      this.tabsEl,
      h(
        "div",
        { class: "panel-actions" },
        btn(icons.plus, `New terminal (${MOD === "⌘" ? "⌃⇧`" : "Ctrl+Shift+`"})`, () => this.create()),
        this.posBtn,
        this.maxBtn,
        btn(icons.close, `Hide panel (${MOD === "⌘" ? "⌃`" : "Ctrl+`"})`, () => actions.hide()),
      ),
    );
    this.body = h("div", { class: "panel-body" });
    this.el = h("section", { class: "panel" }, head, this.body);
  }

  updateButtons(position: "bottom" | "right", maximized: boolean) {
    this.posBtn.innerHTML = position === "bottom" ? icons.panelRight : icons.panelBottom;
    this.posBtn.title = position === "bottom" ? "Move panel right" : "Move panel to bottom";
    this.maxBtn.innerHTML = maximized ? icons.restore : icons.maximize;
    this.maxBtn.title = maximized ? "Restore panel" : "Maximize panel";
  }

  /** Reattaches sessions from the previous page load, or starts a fresh one. */
  restore() {
    const ids = local.get<string[]>("terms", []);
    if (ids.length) ids.forEach((id) => this.create(id, false));
    else this.create();
    if (this.sessions[0] && !this.active) this.activate(this.sessions[0]);
  }

  get count() {
    return this.sessions.length;
  }

  create(id = newId(), activate = true): Session {
    const s: Session = {
      id,
      title: this.shellName,
      ws: null,
      tabEl: h("div", { class: "term-tab", role: "tab" }),
      pending: [],
      exited: false,
      size: { cols: 80, rows: 24 },
      view: null as unknown as TerminalView,
    };
    s.view = new TerminalView({
      fontFamily: this.font.family,
      fontSize: this.font.size,
      lineHeight: this.font.lineHeight,
      theme: this.theme(),
      send: (d) => this.send(s, d),
      resize: (cols, rows) => {
        s.size = { cols, rows };
        if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ t: "resize", cols, rows }));
        else if (!s.ws && !s.exited) this.connect(s);
      },
      onTitle: (t) => {
        s.title = t || this.shellName;
        this.renderTabs();
      },
      onOpenPath: this.onOpenPath,
      onOpenUrl: this.onOpenUrl,
    });
    s.tabEl.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.close(s);
      } else if (!(e.target as HTMLElement).closest(".tab-close")) {
        this.activate(s);
        e.preventDefault();
      }
    });
    this.sessions.push(s);
    this.persist();
    // Mount hidden so the view can measure itself; the first fit() triggers connect().
    s.view.el.hidden = true;
    this.body.append(s.view.el);
    if (activate || !this.active) this.activate(s);
    this.renderTabs();
    return s;
  }

  private connect(s: Session) {
    const { cols, rows } = s.size;
    const ws = new WebSocket(wsUrl(`/ws/pty?id=${s.id}&cols=${cols}&rows=${rows}`));
    ws.binaryType = "arraybuffer";
    s.ws = ws;
    let replay = false;
    ws.onopen = () => {
      for (const p of s.pending) ws.send(p);
      s.pending = [];
      ws.send(JSON.stringify({ t: "resize", cols: s.size.cols, rows: s.size.rows }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data) as { t: string; code?: number };
        if (msg.t === "replay") {
          s.view.reset();
          replay = true;
        }
        else if (msg.t === "exit") this.exited(s, msg.code ?? 0);
        return;
      }
      // History replayed after a reconnect must not re-answer old terminal queries.
      s.view.write(new Uint8Array(ev.data as ArrayBuffer), replay);
      replay = false;
    };
    ws.onclose = (ev) => {
      if (s.ws !== ws) return;
      s.ws = null;
      if (!s.exited && ev.code !== 4000) {
        s.view.write(`\r\n\x1b[2m[connection to codeviewer lost]\x1b[0m\r\n`);
        s.exited = true;
        this.renderTabs();
      }
    };
  }

  private exited(s: Session, code: number) {
    s.exited = true;
    s.view.write(`\r\n\x1b[2m[process exited with code ${code}. Press Enter to restart, ${MOD}W to close]\x1b[0m\r\n`);
    this.renderTabs();
  }

  private send(s: Session, data: string) {
    if (s.exited) {
      if (data === "\r") this.restart(s);
      return;
    }
    const bytes = enc.encode(data);
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(bytes);
    else s.pending.push(bytes);
  }

  private restart(s: Session) {
    s.id = newId();
    s.exited = false;
    s.title = this.shellName;
    s.view.reset();
    this.persist();
    this.connect(s);
    this.renderTabs();
  }

  activate(s: Session) {
    this.active = s;
    for (const o of this.sessions) o.view.el.hidden = o !== s;
    requestAnimationFrame(() => {
      s.view.fit();
      s.view.focus();
    });
    this.renderTabs();
  }

  close(s: Session | null = this.active) {
    if (!s) return;
    const i = this.sessions.indexOf(s);
    if (i < 0) return;
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ t: "kill" }));
    s.ws?.close();
    s.ws = null;
    s.view.dispose();
    s.tabEl.remove();
    this.sessions.splice(i, 1);
    this.persist();
    if (this.active === s) {
      this.active = null;
      const next = this.sessions[Math.min(i, this.sessions.length - 1)];
      if (next) this.activate(next);
      else this.actions.hide();
    }
    this.renderTabs();
  }

  private persist() {
    local.set("terms", this.sessions.map((s) => s.id));
  }

  private renderTabs() {
    for (const [i, s] of this.sessions.entries()) {
      s.tabEl.className = `term-tab${s === this.active ? " active" : ""}${s.exited ? " exited" : ""}`;
      s.tabEl.innerHTML = `<span class="term-dot"></span><span class="tab-name">${esc(s.title || `Terminal ${i + 1}`)}</span><button class="tab-close" title="Kill terminal">${icons.close}</button>`;
      s.tabEl.title = s.title;
      s.tabEl.querySelector(".tab-close")!.addEventListener("click", (e) => {
        e.stopPropagation();
        this.close(s);
      });
    }
    this.tabsEl.replaceChildren(...this.sessions.map((s) => s.tabEl));
  }

  focus() {
    this.active?.view.focus();
  }

  fit() {
    this.active?.view.fit();
  }

  setTheme(t: Theme) {
    for (const s of this.sessions) s.view.setTheme(t);
  }

  setFont(family: string, size: number, lineHeight: number) {
    this.font = { family, size, lineHeight };
    for (const s of this.sessions) s.view.setFont(family, size, lineHeight);
  }
}
