// Entry points for "Copy as Image": context-menu items, the palette command and the context-menu binding.
import type { Command } from "./palette.ts";
import type { MenuItem } from "./menu.ts";

export interface SelectionHost {
  hasSelection(snap?: unknown): boolean;
  copy(snap?: unknown): void;
  copyImage(snap?: unknown): void;
  /** Called on contextmenu: the selection to keep for the menu items (the live one may collapse before a click). */
  capture?(): unknown;
}

/** ["Copy", "Copy as Image"] when something is selected, otherwise no items. */
export function selectionMenuItems(host: SelectionHost, snap?: unknown): MenuItem[] {
  if (!host.hasSelection(snap)) return [];
  return [
    { label: "Copy", run: () => host.copy(snap) },
    { label: "Copy as Image", run: () => host.copyImage(snap) },
  ];
}

/** The "Copy Selection as Image" palette command. */
export function copyImageCommand(host: { copyImage(): void }, keys: string): Command {
  return { id: "selection.copyImage", label: "Copy Selection as Image", keys, run: () => host.copyImage() };
}

/** Shows the selection menu on contextmenu; with no selection the default menu is left alone. */
export function bindSelectionMenu(
  el: { addEventListener(t: string, f: (e: MouseEvent) => void): void },
  host: SelectionHost,
  show: (e: MouseEvent, items: MenuItem[]) => void,
): void {
  el.addEventListener("contextmenu", (e) => {
    const snap = host.capture?.();
    const items = selectionMenuItems(host, snap);
    if (items.length) show(e, items);
  });
}

/** Remembers the selection that existed when the palette opened (opening it moves focus and may drop the live one). */
export function selectionSnapshot<T>(read: () => T | null): { take(): void; value(): T | null; clear(): void } {
  let snap: T | null = null;
  return {
    take() {
      snap = read();
    },
    value: () => snap,
    clear() {
      snap = null;
    },
  };
}

/** The one place that decides which element and which host the selection context menu is bound to. */
export function bindEditorSelectionMenu(
  editor: { el: { addEventListener(t: string, f: (e: MouseEvent) => void): void } },
  host: SelectionHost,
  show: (e: MouseEvent, items: MenuItem[]) => void,
): void {
  bindSelectionMenu(editor.el, host, show);
}
