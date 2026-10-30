import { api, type UpdateInfo } from "./api.ts";
import { icons } from "./icons.ts";
import { h } from "./util.ts";

type Step = "download" | "signature" | "checksum" | "install";

const STEPS: [Step, string][] = [
  ["signature", "Verify release signature"],
  ["download", "Download"],
  ["checksum", "Verify checksum"],
  ["install", "Install"],
];

/**
 * Update dialog: shows what's available, then installs on request with live, verifiable
 * progress (signature → download → checksum → install → restart). Progress arrives as
 * {t: "update"} events on the events socket and is fed in through `onEvent`.
 */
export class Updates {
  readonly el: HTMLElement;
  private box: HTMLElement;
  info: UpdateInfo | null = null;
  private stepEls = new Map<Step, HTMLElement>();
  private installing = false;
  /** Restart the native (macOS) shell. */
  nativeRelaunch: (() => void) | null = null;
  onInfo: (info: UpdateInfo) => void = () => {};

  constructor() {
    this.box = h("div", { class: "upd", role: "dialog", "aria-modal": "true", "aria-label": "Software update", tabindex: "-1" });
    this.el = h("div", { class: "overlay upd-overlay", hidden: true }, this.box);
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el && !this.installing) this.close();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.el.hidden && !this.installing) this.close();
    });
  }

  /** Background status from the launch check (no UI unless something is available). */
  async load() {
    try {
      this.set(await api.update());
    } catch {}
  }

  private set(info: UpdateInfo) {
    this.info = info;
    this.onInfo(info);
  }

  /** "Check for Updates…": always opens the dialog. */
  async checkNow() {
    this.open();
    this.render("checking");
    try {
      this.set(await api.update(true));
      this.render();
    } catch (e) {
      this.render("error", (e as Error).message || "Couldn't reach GitHub");
    }
  }

  private returnTo: Element | null = null;

  open() {
    this.returnTo = document.activeElement;
    this.el.hidden = false;
    if (this.info) this.render();
    (this.box.querySelector<HTMLElement>(".btn") ?? this.box).focus();
  }

  close() {
    this.el.hidden = true;
    (this.returnTo as HTMLElement | null)?.focus?.();
    this.returnTo = null;
  }

  private header(title: string, sub: string) {
    return h(
      "div",
      { class: "upd-head" },
      h("div", { class: "upd-logo", html: icons.logo }),
      h("div", null, h("h2", null, title), h("p", null, sub)),
      h("button", { class: "icon-btn", title: "Close", html: icons.close, onclick: () => !this.installing && this.close() }),
    );
  }

  private render(state?: "checking" | "error", message = "") {
    const i = this.info;
    const actions = h("div", { class: "upd-actions" });
    const body: (HTMLElement | null)[] = [];

    if (state === "checking") {
      this.box.replaceChildren(this.header("Checking for updates…", "Looking at the latest release on GitHub"), h("div", { class: "upd-spin" }));
      return;
    }
    if (state === "error") {
      this.box.replaceChildren(
        this.header("Update failed", message),
        h("div", { class: "upd-actions" }, h("button", { class: "btn", onclick: () => this.close() }, "Close"), h("button", { class: "btn primary", onclick: () => this.checkNow() }, "Try again")),
      );
      return;
    }
    if (!i || !i.available) {
      this.box.replaceChildren(
        this.header("You're up to date", `Codeviewer ${i?.current ?? ""} is the latest version.`),
        h("div", { class: "upd-actions" }, h("button", { class: "btn primary", onclick: () => this.close() }, "OK")),
      );
      return;
    }

    if (i.notes?.trim()) body.push(h("pre", { class: "upd-notes" }, i.notes.trim()));
    const steps = h("ol", { class: "upd-steps", hidden: true });
    this.stepEls.clear();
    for (const [id, label] of STEPS) {
      const li = h("li", { "data-state": "todo" }, h("span", { class: "upd-mark" }), h("span", null, label), h("span", { class: "upd-detail" }));
      this.stepEls.set(id, li);
      steps.append(li);
    }
    body.push(steps);
    if (!i.canInstall) body.push(h("p", { class: "upd-reason" }, i.reason ?? "This update can't be installed automatically."));

    const notesBtn = h("button", { class: "btn", onclick: () => i.url && void api.external(i.url) }, "Release notes");
    actions.append(notesBtn);
    if (i.canInstall) {
      const install = h("button", { class: "btn primary" }, i.kind === "cli" ? "Install update" : "Install and restart");
      install.addEventListener("click", () => void this.install(steps, install, notesBtn));
      actions.append(h("button", { class: "btn", onclick: () => this.close() }, "Later"), install);
    } else {
      actions.append(h("button", { class: "btn primary", onclick: () => this.close() }, "OK"));
    }
    this.box.replaceChildren(
      this.header(`Codeviewer ${i.latest} is available`, `You have ${i.current}. Updates are signed by the release workflow and verified before installing.`),
      ...body.filter((b): b is HTMLElement => !!b),
      actions,
    );
  }

  private async install(steps: HTMLElement, button: HTMLButtonElement, notes: HTMLButtonElement) {
    this.installing = true;
    steps.hidden = false;
    button.disabled = true;
    notes.disabled = true;
    button.textContent = "Installing…";
    this.box.querySelector(".upd-notes")?.remove();
    try {
      await api.updateInstall();
    } catch (e) {
      this.installing = false;
      this.render("error", (e as Error).message);
    }
  }

  /** {t: "update"} events from the server. */
  onEvent(phase: string, detail?: string, relaunch?: "native" | "server" | "manual") {
    if (phase === "error") {
      this.installing = false;
      this.open();
      this.render("error", detail ?? "Unknown error");
      return;
    }
    const order: Step[] = ["signature", "download", "checksum", "install"];
    const idx = order.indexOf(phase as Step);
    if (idx >= 0) {
      order.forEach((s, k) => this.stepEls.get(s)?.setAttribute("data-state", k < idx ? "done" : k === idx ? "active" : "todo"));
      const d = this.stepEls.get(phase as Step)?.querySelector(".upd-detail");
      if (d) d.textContent = phase === "download" && detail ? detail : "";
      return;
    }
    if (phase === "done") {
      order.forEach((s) => this.stepEls.get(s)?.setAttribute("data-state", "done"));
      return;
    }
    if (phase === "installed") {
      this.installing = false;
      // Nothing left to offer: the status-bar pill goes away.
      if (this.info) this.set({ ...this.info, available: false, current: detail ?? this.info.current });
      const actions = this.box.querySelector(".upd-actions");
      if (relaunch === "native" && this.nativeRelaunch) {
        actions?.replaceChildren(h("span", { class: "upd-ok" }, `Codeviewer ${detail} installed. Restarting…`));
        setTimeout(() => this.nativeRelaunch?.(), 600);
      } else if (relaunch === "server") {
        actions?.replaceChildren(h("span", { class: "upd-ok" }, `Codeviewer ${detail} installed. Restarting…`));
        void api.updateRelaunch();
      } else {
        actions?.replaceChildren(
          h("span", { class: "upd-ok" }, `Codeviewer ${detail} installed. Restart codeviewer to use it.`),
          h("button", { class: "btn primary", onclick: () => this.close() }, "OK"),
        );
      }
    }
  }
}
