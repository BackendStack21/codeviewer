import { icons } from "./icons.ts";
import { h, IS_MAC, key } from "./util.ts";

/** A sheet of every shortcut and the two terminal tips, in the platform's own key names (⌘/ or Ctrl+/). */
export class Help {
  readonly el: HTMLElement;
  private box: HTMLElement;
  private returnTo: Element | null = null;

  constructor() {
    const row = (k: string, label: string) => h("div", { class: "kb-row" }, h("span", null, label), h("kbd", null, k));
    const group = (title: string, rows: HTMLElement[]) => [h("h3", null, title), h("div", { class: "kb" }, ...rows)];
    this.box = h(
      "div",
      { class: "upd help", role: "dialog", "aria-modal": "true", "aria-label": "Keyboard shortcuts", tabindex: "-1" },
      h("div", { class: "upd-head" }, h("div", { class: "upd-logo", html: icons.search }), h("div", null, h("h2", null, "Keyboard shortcuts"), h("p", null, `Press ${key("⌘/", "Ctrl+/")} any time to see this sheet.`)), h("button", { class: "btn", onclick: () => this.close() }, "Close")),
      ...group("Files", [
        row(key("⌘P", "Ctrl+P"), "Go to file (path:line works)"),
        row(key("⌘⇧P", "Ctrl+Shift+P"), "Command palette"),
        row(key("⌘⇧E", "Ctrl+Shift+E"), "Focus the explorer"),
        row(key("⇧F10", "Shift+F10"), "Context menu for the selected explorer entry"),
        row(key("⌘B", "Ctrl+B"), "Toggle the sidebar"),
        row(key("⌘W", "Ctrl+W"), "Close tab"),
        row(key("⌘⇧[ ⌘⇧] · ⌃Tab", "Ctrl+Shift+[ ] · Ctrl+Tab"), "Previous / next tab"),
      ]),
      ...group("In a file", [
        row(key("⌘F", "Ctrl+F"), "Find in file"),
        row(key("⌃G", "Ctrl+G"), "Go to line"),
        row(key("⌘⇧F", "Ctrl+Shift+F"), "Search in files"),
        row(key("F4 · ⇧F4", "F4 · Shift+F4"), "Next / previous search result"),
        row(key("⌘= ⌘- ⌘0", "Ctrl+= Ctrl+- Ctrl+0"), "Font size (code, terminal and chrome)"),
      ]),
      ...group("Git", [
        row(key("⌘⇧G", "Ctrl+Shift+G"), "Changes: every file the branch touched, as diffs"),
        row(key("⌥F5 · ⌥⇧F5", "Alt+F5 · Alt+Shift+F5"), "Next / previous change (then the next file)"),
        row("click a gutter mark", "Peek at what HEAD had (or run \u201cGit: Peek HEAD\u201d from the palette)"),
      ]),
      ...group("Terminal", [
        row(key("⌃`", "Ctrl+`"), "Toggle / focus the terminal"),
        row(key("⌃⇧`", "Ctrl+Shift+`"), "New terminal"),
        row(key("⌘J", "Ctrl+J"), "Hide / show the terminal panel"),
        row(key("⌘⇧[ ⌘⇧]", "Ctrl+Shift+[ ]"), "Previous / next terminal (while the terminal has focus)"),
        row(key("⌘W", "Ctrl+W"), IS_MAC ? "Close an exited terminal; a running one asks for a second press" : "Close an exited terminal (a running shell keeps Ctrl+W)"),
        row(key("⌘-click", "Ctrl+click"), "Open a path:line or a URL printed in the terminal"),
        row(key("⌘C · ⌘V", "Ctrl+Shift+C · Ctrl+Shift+V"), "Copy the selection · paste"),
      ]),
      h("p", { class: "welcome-hint" }, "Tip: run ", h("code", null, "codeviewer open <file>:<line>"), " inside the terminal and the viewer opens that file. Agents can use it to show you what they mean."),
    );
    this.el = h("div", { class: "overlay upd-overlay", hidden: true }, h("div", { class: "upd-shell" }, this.box));
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.el.hidden) this.close();
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.returnTo = document.activeElement;
    this.el.hidden = false;
    this.box.focus();
  }

  close() {
    this.el.hidden = true;
    (this.returnTo as HTMLElement | null)?.focus?.();
    this.returnTo = null;
  }
}
