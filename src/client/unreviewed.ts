/** Next / previous unreviewed changed file: palette commands and the announcement they make. */

export const UNREVIEWED_COMMANDS = [
  { id: "changes.nextUnreviewed", title: "Changes: Next Unreviewed File", dir: 1 },
  { id: "changes.prevUnreviewed", title: "Changes: Previous Unreviewed File", dir: -1 },
] as const;

export interface UnreviewedDeps {
  view: { files: readonly { path: string }[]; stepUnreviewed(dir: 1 | -1): { path: string } | null; unreviewedCount(): number; setCurrent?(path: string): void };
  announce(message: string): void;
}

/** Opens the next / previous unreviewed file and says where it landed through the live region (no toast). */
export function runUnreviewed(dir: 1 | -1, deps: UnreviewedDeps): void {
  const { view, announce } = deps;
  if (view.files.length === 0) return announce("No changes");
  const f = view.stepUnreviewed(dir);
  if (!f) return announce(`All ${view.files.length} changed files reviewed`);
  view.setCurrent?.(f.path); // the diff loads later: count the file as reviewed now so a quick repeat moves on
  announce(`${f.path}, ${view.unreviewedCount()} unreviewed left`);
}

/** Announcer for a live region element: clears it first so an identical message is read again. */
export function liveAnnouncer(el: { textContent: string | null }): (message: string) => void {
  return (message) => {
    el.textContent = "";
    el.textContent = message;
  };
}
