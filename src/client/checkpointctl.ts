// The controller behind the three "Changes: ... Checkpoint" commands. app.ts only wires it up.
import type { ChangeFile } from "./api.ts";
import type { PickItem } from "./palette.ts";
import { sinceCheckpoint, takeCheckpoint, type Checkpoint } from "./checkpoint.ts";
import { showHidden } from "./util.ts";

export const CHECKPOINT_COMMANDS = [
  { id: "changes.checkpoint", title: "Changes: Set Checkpoint" },
  { id: "changes.sinceCheckpoint", title: "Changes: Since Checkpoint\u2026" },
  { id: "changes.clearCheckpoint", title: "Changes: Clear Checkpoint" },
] as const;

export interface SinceDiff {
  path: string;
  status: "A" | "M" | "D";
  /** null = the file does not exist on that side. */
  oldText: string | null;
  newText: string | null;
  /** "HH:MM" of the checkpoint. */
  since: string;
}

export interface CheckpointDeps {
  changes(): Promise<{ repo: boolean; rev: string | null; files: ChangeFile[] }>;
  /** Current text; null = missing; undefined = binary, too large or unreadable. */
  readText(path: string): Promise<string | null | undefined>;
  baseText(path: string, rev: string): Promise<string | null | undefined>;
  now(): number;
  notify(message: string): void;
  pick(items: PickItem[], title: string): void;
  openDiff(d: SinceDiff): void;
}

type Listing = { repo: boolean; rev: string | null; files: ChangeFile[] };

export class CheckpointController {
  private cp: Checkpoint | null = null;
  private gen = 0;
  constructor(private deps: CheckpointDeps) {}
  get checkpoint(): Checkpoint | null {
    return this.cp;
  }

  private async list(): Promise<Listing | null> {
    let l: Listing;
    try {
      l = await this.deps.changes();
    } catch {
      this.deps.notify("Could not read the changes");
      return null;
    }
    if (!l.repo) {
      this.deps.notify("Not a git repository");
      return null;
    }
    return l;
  }

  /** Current texts of the listed files; binary and unreadable ones are returned apart. */
  private async read(files: ChangeFile[]) {
    const listed = new Set(files.map((f) => f.path));
    const out: { path: string; text: string | null }[] = [];
    const unreadable: string[] = [];
    for (const f of files) {
      // A rename is a delete plus an add: the old path is gone whatever the new file turns out to be.
      if (f.status === "R" && f.oldPath !== undefined && f.oldPath !== f.path && !listed.has(f.oldPath)) out.push({ path: f.oldPath, text: null });
      if (f.binary) {
        unreadable.push(f.path);
        continue;
      }
      const text = f.status === "D" ? null : await this.deps.readText(f.path);
      if (text === undefined) {
        unreadable.push(f.path);
        continue;
      }
      out.push({ path: f.path, text });
    }
    return { out, unreadable };
  }

  async set(): Promise<void> {
    const gen = ++this.gen;
    const l = await this.list();
    if (!l || gen !== this.gen) return;
    const at = this.deps.now();
    const { out, unreadable } = await this.read(l.files);
    if (gen !== this.gen) return;
    const t = takeCheckpoint(out, at, l.rev);
    const cp = { ...t, skipped: [...t.skipped, ...unreadable] };
    this.cp = cp;
    const n = cp.texts.size;
    const m = cp.skipped.length;
    this.deps.notify(m ? `Checkpoint set (${n} files, ${m} skipped)` : `Checkpoint set (${n} files)`);
  }

  async since(): Promise<void> {
    const cp = this.cp;
    if (!cp) return this.deps.notify("No checkpoint set");
    const l = await this.list();
    if (!l) return;
    const { out, unreadable } = await this.read(l.files);
    const current = new Map(out.map((o) => [o.path, o.text]));
    const derived: Checkpoint = { ...cp, skipped: [...cp.skipped, ...unreadable] };
    const skip = new Set(derived.skipped);
    const base = new Map<string, string | null | undefined>();
    try {
      for (const p of new Set([...current.keys(), ...cp.texts.keys()])) {
        if (skip.has(p) || (cp.texts.has(p) && current.has(p))) continue;
        base.set(p, cp.rev === null ? null : await this.deps.baseText(p, cp.rev));
      }
    } catch {
      if (this.cp === cp) this.deps.notify("Could not compare with the checkpoint");
      return;
    }
    if (this.cp !== cp) return;
    const baseOf = (p: string) => base.get(p);
    const entries = sinceCheckpoint(derived, current, baseOf);
    const since = hhmm(cp.at);
    if (!entries.length) return this.deps.notify(`Nothing changed since the checkpoint (${since})`);
    const items: PickItem[] = entries.map((e) => ({
      label: showHidden(e.path),
      detail: `+${e.added} \u2212${e.removed}`,
      icon: `<span class="gbadge git-${e.status}" aria-hidden="true">${e.status}</span>`,
      run: () =>
        this.deps.openDiff({
          path: e.path,
          status: e.status,
          since,
          oldText: cp.texts.has(e.path) ? cp.texts.get(e.path)! : baseOf(e.path)!,
          newText: current.has(e.path) ? current.get(e.path)! : baseOf(e.path)!,
        }),
    }));
    this.deps.pick(items, `Changes since ${since}: ${items.length} ${items.length === 1 ? "file" : "files"}, type to filter`);
  }

  clear(): void {
    this.gen++; // a set() still reading must not bring the checkpoint back
    this.cp = null;
    this.deps.notify("Checkpoint cleared");
  }
}

/** Local time of day, 24-hour, zero padded. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
