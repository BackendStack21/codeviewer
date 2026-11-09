// Changes since a checkpoint: pure helpers, no DOM and no network.
import { diffLines } from "./diff.ts";

export interface Checkpoint {
  at: number;
  rev: string | null;
  texts: Map<string, string | null>;
  skipped: string[];
}
export interface SinceEntry {
  path: string;
  status: "A" | "M" | "D";
  added: number;
  removed: number;
}

const MAX_FILES = 500;
const MAX_CHARS = 16_000_000;

/** Remembers the text of every file that differs from HEAD now, within the file and character caps. */
export function takeCheckpoint(
  files: readonly { path: string; text: string | null }[],
  at: number,
  rev: string | null,
  limits?: { files?: number; chars?: number },
): Checkpoint {
  const maxFiles = limits?.files ?? MAX_FILES;
  const maxChars = limits?.chars ?? MAX_CHARS;
  const texts = new Map<string, string | null>();
  const skipped: string[] = [];
  let chars = 0;
  for (const f of files) {
    const n = f.text === null ? 0 : f.text.length;
    if (texts.size < maxFiles && chars + n <= maxChars) {
      texts.set(f.path, f.text);
      chars += n;
    } else skipped.push(f.path);
  }
  return { at, rev, texts, skipped };
}

function linesOf(text: string | null): string[] {
  if (text === null) return [];
  const l = text.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
}

/** What changed in each file between the checkpoint and now. */
export function sinceCheckpoint(
  cp: Checkpoint,
  current: ReadonlyMap<string, string | null>,
  base: (path: string) => string | null | undefined,
): SinceEntry[] {
  const skipped = new Set(cp.skipped);
  const paths = new Set<string>([...current.keys(), ...cp.texts.keys()]);
  const out: SinceEntry[] = [];
  for (const path of [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (skipped.has(path)) continue;
    const old = cp.texts.has(path) ? cp.texts.get(path) : base(path);
    const now = current.has(path) ? current.get(path) : base(path);
    if (old === undefined || now === undefined || old === now) continue;
    let added = 0;
    let removed = 0;
    for (const h of diffLines(linesOf(old), linesOf(now))) {
      added += h.b1 - h.b0;
      removed += h.a1 - h.a0;
    }
    out.push({ path, status: old === null ? "A" : now === null ? "D" : "M", added, removed });
  }
  return out;
}
