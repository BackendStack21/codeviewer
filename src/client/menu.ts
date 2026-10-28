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
  const el = h(
    "div",
    { class: "ctx-menu", role: "menu" },
    items.map((it) =>
      h("button", {
        class: "ctx-item",
        role: "menuitem",
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

  const onDown = (ev: Event) => {
    if (!el.contains(ev.target as Node)) closeContextMenu();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeContextMenu();
    }
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
      el.remove();
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
      window.removeEventListener("wheel", onBlur, true);
      current = null;
    },
  };
  (el.firstElementChild as HTMLElement | null)?.focus();
}
