/** Keyboard routing helpers shared by the app shell (pure, so they can be unit tested). */

export type SideView = "explorer" | "search";

export interface KeyLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export type SearchKeyAction = "search" | "find" | "next" | "prev";

/**
 * Maps a key event to a search-related action, or null.
 * Cmd/Ctrl+Shift+F opens Search in Files (also from the terminal), plain Cmd/Ctrl+F opens
 * the find bar (not from the terminal), F4 / Shift+F4 step through results (not from the terminal).
 */
export function searchKey(e: KeyLike, o: { isMac: boolean; inTerm: boolean }): SearchKeyAction | null {
  const mod = o.isMac ? !!e.metaKey : !!e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "f") return e.shiftKey ? "search" : o.inTerm ? null : "find";
  if (e.key === "F4" && !e.ctrlKey && !e.metaKey && !e.altKey && !o.inTerm) return e.shiftKey ? "prev" : "next";
  return null;
}

/** Normalises a persisted sidebar view; anything unknown falls back to the Explorer. */
export function normSideView(v: unknown): SideView {
  return v === "search" ? "search" : "explorer";
}
