/** Keyboard routing helpers shared by the app shell (pure, so they can be unit tested). */

export type SideView = "explorer" | "search" | "changes";

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
  return v === "search" || v === "changes" ? v : "explorer";
}

/**
 * True for the "show all shortcuts" key: Cmd/Ctrl+/. On layouts where "/" needs Shift (German,
 * Swiss, Nordic, Spanish, Italian…: Shift+7), WebKit on macOS reports Cmd+Shift+7 as key "7",
 * code "Digit7", so the physical Shift+7 chord also counts. The Slash code is not matched: on
 * those layouts that key is "-" and Cmd+- is zoom out.
 */
export function helpKey(e: KeyLike, o: { isMac: boolean }): boolean {
  const mod = o.isMac ? !!e.metaKey : !!e.ctrlKey;
  if (!mod) return false;
  if (e.key === "/") return true;
  return !!e.shiftKey && e.code === "Digit7" && e.key === "7";
}

/** Cmd/Ctrl+Shift+O: Go to Symbol in the active file. */
export function symbolKey(e: KeyLike, o: { isMac: boolean }): boolean {
  const mod = o.isMac ? !!e.metaKey : !!e.ctrlKey;
  return mod && !!e.shiftKey && !e.altKey && e.key.toLowerCase() === "o";
}

/**
 * Cmd+Option+C / Ctrl+Alt+C: copy a `path:line` reference. On a Mac, Option turns the key into
 * "ç" (or another symbol), so the physical C key also counts when the key is not a letter; a
 * letter means the layout puts another one there (Dvorak), and only "c" itself matches.
 */
export function referenceKey(e: KeyLike, o: { isMac: boolean }): boolean {
  const mod = o.isMac ? !!e.metaKey : !!e.ctrlKey;
  if (!mod || !e.altKey || e.shiftKey) return false;
  return e.key.toLowerCase() === "c" || (e.code === "KeyC" && !/^[a-z]$/i.test(e.key));
}
