// Entry points for "Copy as Image": context-menu items, the palette command and the context-menu binding.
import type { Command } from "./palette.ts";
import type { MenuItem } from "./menu.ts";

export interface SelectionHost {
  hasSelection(): boolean;
  copy(): void;
  copyImage(): void;
}

/** ["Copy", "Copy as Image"] when something is selected, otherwise no items. */
export function selectionMenuItems(host: SelectionHost): MenuItem[] {
  if (!host.hasSelection()) return [];
  return [
    { label: "Copy", run: () => host.copy() },
    { label: "Copy as Image", run: () => host.copyImage() },
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
    const items = selectionMenuItems(host);
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
