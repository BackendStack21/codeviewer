import { dirname } from "./util.ts";

export interface GitStatus {
  repo: boolean;
  branch: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  state: string | null;
  stash: number;
  files: Record<string, string>;
  head: { hash: string; subject: string; author: string; time: number } | null;
}

/** Display status, VS Code style: Modified, Added, Untracked, Deleted, Renamed, Conflict, Ignored. */
export type Letter = "M" | "A" | "U" | "D" | "R" | "C" | "I";

export interface FileGit {
  letter: Letter;
  /** Human description, e.g. "Modified (staged), modified" */
  label: string;
  /** Raw porcelain XY, e.g. "AM" (in the index, not in HEAD) */
  xy: string;
}

const PRIORITY: Record<Letter, number> = { C: 6, D: 5, M: 4, R: 3, A: 2, U: 1, I: 0 };
const CONFLICT = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const WORDS: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

function describe(xy: string): FileGit {
  if (xy === "??") return { letter: "U", label: "Untracked", xy };
  if (xy === "!!") return { letter: "I", label: "Ignored", xy };
  if (CONFLICT.has(xy)) return { letter: "C", label: "Conflict", xy };
  const [x, y] = [xy[0]!, xy[1]!];
  const parts: string[] = [];
  if (x !== ".") parts.push(`${WORDS[x] ?? x} (staged)`);
  if (y !== ".") parts.push(WORDS[y] ?? y);
  const label = parts.join(", ").replace(/^./, (c) => c.toUpperCase());
  const code = y !== "." ? y : x;
  const letter: Letter = code === "D" ? "D" : code === "A" ? "A" : code === "R" || code === "C" ? "R" : "M";
  return { letter, label, xy };
}

/** macOS file systems hand out NFD names while git reports NFC: compare in NFC. */
const nfc = (p: string) => (/[^\x00-\x7f]/.test(p) ? p.normalize("NFC") : p);

/** Indexed view of `git status` for fast per-path lookups while rendering. */
export class GitState {
  status: GitStatus = { repo: false } as GitStatus;
  private files = new Map<string, FileGit>();
  private prefixes = new Map<string, FileGit>(); // untracked/ignored directories (no trailing "/")
  private prev = { files: this.files, prefixes: this.prefixes };
  private dirs = new Map<string, Letter>();
  private listeners = new Set<() => void>();
  counts = { changed: 0, staged: 0, untracked: 0, conflicts: 0 };

  set(s: GitStatus) {
    this.status = s;
    this.prev = { files: this.files, prefixes: this.prefixes };
    this.files = new Map();
    this.prefixes = new Map();
    this.dirs.clear();
    this.counts = { changed: 0, staged: 0, untracked: 0, conflicts: 0 };
    for (const [raw, xy] of Object.entries(s.files ?? {})) {
      const g = describe(xy);
      const p = nfc(raw);
      if (p.endsWith("/")) this.prefixes.set(p.slice(0, -1), g);
      else this.files.set(p, g);
      if (g.letter === "I") continue;
      if (g.letter === "U") this.counts.untracked++;
      else if (g.letter === "C") this.counts.conflicts++;
      else this.counts.changed++;
      if (xy[0] !== "." && xy[0] !== "?" && !CONFLICT.has(xy)) this.counts.staged++;
      // Folders take the most important status found anywhere inside them.
      let d = dirname(p.endsWith("/") ? p.slice(0, -1) : p);
      while (d) {
        const cur = this.dirs.get(d);
        if (!cur || PRIORITY[g.letter] > PRIORITY[cur]) this.dirs.set(d, g.letter);
        d = dirname(d);
      }
    }
    this.listeners.forEach((f) => f());
  }

  onChange(f: () => void) {
    this.listeners.add(f);
  }

  get repo() {
    return this.status.repo;
  }

  file(path: string): FileGit | null {
    path = nfc(path);
    return this.files.get(path) ?? underPrefix(this.prefixes, path);
  }

  /** True if the last status update took `path` from changed to clean or ignored. */
  cleared(path: string): boolean {
    path = nfc(path);
    const was = this.prev.files.get(path) ?? underPrefix(this.prev.prefixes, path);
    return !!was && was.letter !== "I" && (this.file(path)?.letter ?? "I") === "I";
  }

  /** Status of a directory: its own (untracked/ignored) or the strongest inside it. */
  dir(path: string): Letter | null {
    path = nfc(path);
    return (this.prefixes.get(path) ?? underPrefix(this.prefixes, path))?.letter ?? this.dirs.get(path) ?? null;
  }

  /** Changed (non-ignored) files, most important first. */
  changedFiles(): { path: string; git: FileGit }[] {
    const out: { path: string; git: FileGit }[] = [];
    for (const [path, git] of this.files) if (git.letter !== "I") out.push({ path, git });
    for (const [path, git] of this.prefixes) if (git.letter !== "I") out.push({ path: path + "/", git });
    return out.sort((a, b) => PRIORITY[b.git.letter] - PRIORITY[a.git.letter] || a.path.localeCompare(b.path));
  }
}

/** Nearest untracked/ignored ancestor directory, walking up (O(depth)). */
function underPrefix(prefixes: Map<string, FileGit>, path: string): FileGit | null {
  if (!prefixes.size) return null;
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const g = prefixes.get(path.slice(0, i));
    if (g) return g;
  }
  return null;
}

export function relativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  const units: [number, string][] = [
    [60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.35, "week"], [12, "month"], [Infinity, "year"],
  ];
  let v = s;
  for (const [size, name] of units) {
    if (Math.abs(v) < size) {
      v = Math.max(1, Math.round(v));
      return name === "second" ? "just now" : `${v} ${name}${v === 1 ? "" : "s"} ago`;
    }
    v /= size;
  }
  return "";
}
