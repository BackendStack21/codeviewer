import { h } from "./util.ts";

export interface MenuItem {
  label: string;
  run: () => void;
}

let current: { dispose: () => void } | null = null;

export function closeContextMenu() {
  current?.dispose();
}

/** Shows a small context menu at the pointer, replacing the browser's (or WebView's) own. */
export function showContextMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  closeContextMenu();
  // Focus goes back here when the menu closes, so keyboard navigation carries on where it was.
  const returnTo = document.activeElement as HTMLElement | null;
  const el = h(
    "div",
    { class: "ctx-menu", role: "menu" },
    items.map((it) =>
      h("button", {
        class: "ctx-item",
        role: "menuitem",
        tabindex: "-1",
        onclick: () => {
          closeContextMenu();
          it.run();
        },
      }, it.label),
    ),
  );
  document.body.append(el);
  // Keep it on screen.
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4))}px`;

  const buttons = [...el.querySelectorAll<HTMLElement>(".ctx-item")];
  const onDown = (ev: Event) => {
    if (!el.contains(ev.target as Node)) closeContextMenu();
  };
  // While open, the menu owns the keyboard: no shortcut runs underneath it.
  const onKey = (ev: KeyboardEvent) => {
    ev.stopPropagation();
    if (["Shift", "Control", "Alt", "Meta"].includes(ev.key)) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      const i = buttons.indexOf(document.activeElement as HTMLElement);
      const n = buttons.length;
      buttons[(i + (ev.key === "ArrowDown" ? 1 : n - 1)) % n]?.focus();
    } else if (ev.key === "Enter" || ev.key === " ") {
      if (!el.contains(document.activeElement)) return ev.preventDefault();
      return; // the focused button's own click
    } else closeContextMenu();
    ev.preventDefault();
  };
  const onBlur = () => closeContextMenu();
  // Capture phase, so a click elsewhere closes the menu even if a handler stops propagation.
  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onBlur);
  window.addEventListener("wheel", onBlur, { passive: true, capture: true });
  current = {
    dispose: () => {
      current = null;
      el.remove();
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
      window.removeEventListener("wheel", onBlur, true);
      // Only if focus was still in the menu (or lost with it); a click elsewhere keeps its target.
      if (returnTo?.isConnected && (!document.activeElement || document.activeElement === document.body)) {
        returnTo.focus({ preventScroll: true });
      }
    },
  };
  buttons[0]?.focus();
}
