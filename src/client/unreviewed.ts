/** Next / previous unreviewed changed file: palette commands and the announcement they make. */

export const UNREVIEWED_COMMANDS = [
  { id: "changes.nextUnreviewed", title: "Changes: Next Unreviewed File", dir: 1 },
  { id: "changes.prevUnreviewed", title: "Changes: Previous Unreviewed File", dir: -1 },
] as const;

export interface UnreviewedDeps {
  view: { files: readonly { path: string }[]; stepUnreviewed(dir: 1 | -1): { path: string } | null; unreviewedCount(): number };
  announce(message: string): void;
}

/** Opens the next / previous unreviewed file and says where it landed through the live region (no toast). */
export function runUnreviewed(dir: 1 | -1, deps: UnreviewedDeps): void {
  const { view, announce } = deps;
  if (view.files.length === 0) return announce("No changes");
  const f = view.stepUnreviewed(dir);
  if (!f) return announce(`All ${view.files.length} changed files reviewed`);
  announce(`${f.path}, ${view.unreviewedCount()} unreviewed left`);
}
