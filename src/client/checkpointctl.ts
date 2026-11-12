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

/**
 * Text for a checkpoint: the string; null = the file vanished (a 404); undefined = binary, truncated,
 * too large or otherwise unreadable.
 */
export async function checkpointText(
  read: () => Promise<{ kind: string; truncated: boolean; text: string }>,
): Promise<string | null | undefined> {
  try {
    const f = await read();
    return f.kind === "text" && !f.truncated ? f.text : undefined;
  } catch (e) {
    return typeof e === "object" && e !== null && (e as { status?: unknown }).status === 404 ? null : undefined;
  }
}

/**
 * One line standing in for a file whose text cannot be compared (binary, image, too large): its
 * size and modification time, so a change still shows. null = the file vanished; undefined = unknown.
 */
export async function describeFile(
  read: () => Promise<{ kind: string; truncated: boolean; size: number; mtime: number }>,
): Promise<string | null | undefined> {
  try {
    const f = await read();
    const what = f.kind === "image" ? "Image" : f.kind === "text" ? "Large text file" : "Binary file";
    return `${what}: ${f.size.toLocaleString("en-US")} bytes, modified ${new Date(f.mtime).toISOString()}\n`;
  } catch (e) {
    return typeof e === "object" && e !== null && (e as { status?: unknown }).status === 404 ? null : undefined;
  }
}

/** A file's text at a commit: null when it is not there; a one-line stand-in when it is binary (415). */
export async function checkpointBase(read: () => Promise<{ status: number; text: string }>, rev: string): Promise<string | null> {
  const r = await read();
  if (r.status === 415) return `Binary file at commit ${rev.slice(0, 10)}\n`;
  return r.status === 200 ? r.text : null;
}

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
  /** A stand-in line for a file with no comparable text (see describeFile). Without it such files are skipped. */
  describe?(path: string): Promise<string | null | undefined>;
  /** Paths that differ between two commits (`from` null: no commit then); null when they cannot be listed. */
  between?(from: string | null, to: string): Promise<string[] | null>;
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
      if (f.binary && !this.deps.describe) {
        unreadable.push(f.path);
        continue;
      }
      let text = f.status === "D" ? null : f.binary ? undefined : await this.deps.readText(f.path);
      // Binary, image or too large: compared by a description (size, modification time) instead.
      if (text === undefined && this.deps.describe) text = await this.deps.describe(f.path);
      // The server answers 404 for a symlink that leaves the root as well as for a missing file, so a
      // symlink's 404 does not mean it vanished: it is skipped.
      if (text === null && f.status !== "D" && f.newMode === "120000") text = undefined;
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
    // A path missing from one listing was unchanged against HEAD at that moment: the checkpoint's
    // HEAD for the old side, the current HEAD for the new one. They differ once a commit was made
    // (read at the old HEAD, a file committed as it was showed a diff back to its old content).
    const base = new Map<string, string | null | undefined>();
    const head = new Map<string, string | null | undefined>();
    // A file that was clean at the checkpoint and is clean now is in neither listing, yet a commit
    // made in between may have changed it: those paths come from the two HEADs.
    let committed: string[] = [];
    try {
      if (l.rev !== null && l.rev !== cp.rev && this.deps.between) {
        const paths = await this.deps.between(cp.rev, l.rev);
        if (paths === null) throw new Error("no listing");
        committed = paths;
      }
      for (const p of new Set([...current.keys(), ...cp.texts.keys(), ...committed])) {
        if (skip.has(p)) continue;
        if (!current.has(p)) head.set(p, l.rev === null ? null : await this.deps.baseText(p, l.rev));
        if (!cp.texts.has(p)) base.set(p, cp.rev === null ? null : await this.deps.baseText(p, cp.rev));
      }
    } catch {
      if (this.cp === cp) this.deps.notify("Could not compare with the checkpoint");
      return;
    }
    if (this.cp !== cp) return;
    const baseOf = (p: string) => base.get(p);
    const headOf = (p: string) => head.get(p);
    const entries = sinceCheckpoint(derived, current, baseOf, headOf, committed);
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
          newText: current.has(e.path) ? current.get(e.path)! : headOf(e.path)!,
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
