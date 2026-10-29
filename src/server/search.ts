// Project-wide content search: pure matcher (compileQuery, matchText), scanner and candidate list.
import { resolveSafe } from "./files.ts";
import type { Git } from "./git.ts";
import type { FileIndex } from "./index.ts";

export interface SearchMatch {
  line: number;
  col: number;
  len: number;
  preview: string;
  pcol: number;
}

export interface SearchOptions {
  regex?: boolean;
  case?: boolean;
  word?: boolean;
}

export type CompiledQuery = { ok: true; re: RegExp } | { ok: false; error: string };

export interface MatchResult {
  matches: SearchMatch[];
  more: number;
}

const MAX_QUERY = 256;
const PREVIEW_LEN = 200;
const PREVIEW_LEAD = 30;

export function compileQuery(q: string, o: SearchOptions = {}): CompiledQuery {
  if (!q) return { ok: false, error: "Empty query" };
  if (q.length > MAX_QUERY) return { ok: false, error: "Query too long" };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(q)) return { ok: false, error: "Invalid characters in query" };
  let src = o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (o.word) src = `\\b(?:${src})\\b`;
  try {
    return { ok: true, re: new RegExp(src, o.case ? "gu" : "giu") };
  } catch {
    return { ok: false, error: "Invalid regular expression" };
  }
}

export function matchText(text: string, re: RegExp, maxPerFile = 100): MatchResult {
  const matches: SearchMatch[] = [];
  let more = 0;
  // Line starts, split on \r\n | \r | \n like the client.
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (c === 10) starts.push(i + 1);
  }
  const lineEnd = (n: number): number => {
    let e = n + 1 < starts.length ? starts[n + 1]! : text.length + 1;
    e--; // drop the terminator's last char
    if (n + 1 < starts.length && text.charCodeAt(e - 1) === 13 && text.charCodeAt(e) === 10) e--;
    return e;
  };
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      const cp = text.codePointAt(re.lastIndex);
      re.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
      continue;
    }
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= m.index) lo = mid;
      else hi = mid - 1;
    }
    const ls = starts[lo]!;
    const col = m.index - ls;
    const len = Math.min(m[0].length, lineEnd(lo) - m.index);
    if (len <= 0) continue;
    if (matches.length >= maxPerFile) {
      more++;
      continue;
    }
    const line = text.slice(ls, lineEnd(lo));
    let start = col > PREVIEW_LEAD ? col - PREVIEW_LEAD : 0;
    const lowSurrogate = (i: number) => (line.charCodeAt(i) & 0xfc00) === 0xdc00;
    if (start > 0 && lowSurrogate(start)) start++;
    let end = start + PREVIEW_LEN;
    if (end < line.length && (line.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
    const lead = start > 0 ? "…" : "";
    matches.push({
      line: lo + 1,
      col,
      len,
      preview: lead + line.slice(start, end),
      pcol: lead.length + col - start,
    });
  }
  return { matches, more };
}

// ───────────── SL02 scaffolding: scanner + worker + endpoint (stubs, filled in by implement) ─────────────

/** Wall-clock budget for one search before the worker is terminated. */
export const SEARCH_DEADLINE_MS = 10_000;
/** Total matches streamed before the search stops with truncated === "matches". */
export const MAX_TOTAL_MATCHES = 2000;

export type SearchEvent =
  | { t: "file"; path: string; matches: SearchMatch[]; more?: number }
  | { t: "done"; files: number; matches: number; skipped: number; truncated: false | "matches" | "time"; ms: number; error?: true };

export interface ScanRequest {
  root: string;
  files: string[];
  q: string;
  opts: SearchOptions;
}

/** Runs one search, emitting events; resolves when finished or cancelled. Injectable for tests. */
export type Scanner = (req: ScanRequest, signal: AbortSignal, emit: (e: SearchEvent) => void) => Promise<void>;

/** Messages the worker posts back to the main thread. */
export type WorkerMsg =
  | { t: "file"; path: string; matches: SearchMatch[]; more?: number }
  | { t: "skip" }
  | { t: "done"; files: number; matches: number; skipped: number; truncated: false | "matches" };

export interface WorkerJob {
  req: ScanRequest;
  /** Int32Array over this buffer: element 0 becomes 1 when the search is cancelled. */
  cancel: SharedArrayBuffer;
}

/**
 * Real scanner: every pattern runs in a fresh Worker, so a runaway regex can be killed with
 * terminate() and never touches the main thread. Resolves when finished, cancelled or timed out.
 */
export function createWorkerScanner(deadlineMs: number = SEARCH_DEADLINE_MS): Scanner {
  return (req, signal, emit) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return resolve();
      const t0 = performance.now();
      const cancel = new SharedArrayBuffer(4);
      const flag = new Int32Array(cancel);
      const worker = new Worker(new URL("./search.worker.ts", import.meta.url));
      let files = 0;
      let matches = 0;
      let skipped = 0;
      let settled = false;
      const finish = (err?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal.removeEventListener("abort", onAbort);
        worker.terminate();
        if (err) reject(new Error("search failed"));
        else resolve();
      };
      const deadline = setTimeout(() => {
        if (settled) return;
        emit({ t: "done", files, matches, skipped, truncated: "time", ms: Math.round(performance.now() - t0) });
        finish();
      }, deadlineMs);
      const onAbort = () => {
        Atomics.store(flag, 0, 1);
        finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
        if (settled) return;
        const m = e.data;
        if (m.t === "file") {
          files++;
          matches += m.matches.length;
          emit(m.more ? { t: "file", path: m.path, matches: m.matches, more: m.more } : { t: "file", path: m.path, matches: m.matches });
        } else if (m.t === "skip") skipped++;
        else if (m.t === "done") {
          emit({ ...m, ms: Math.round(performance.now() - t0) });
          finish();
        }
      };
      worker.onerror = (ev) => {
        ev.preventDefault?.();
        finish(new Error("worker"));
      };
      worker.postMessage({ req, cancel } satisfies WorkerJob);
    });
}

// ───────────── SL03 scaffolding: candidate list (stubs, filled in by implement) ─────────────

/** Splits a comma-separated glob list: trimmed, empty entries dropped; `\,` is a literal comma, other escapes are kept for Bun.Glob. */
export function parseGlobs(s: string | null | undefined): string[] {
  const out: string[] = [];
  let cur = "";
  const str = s ?? "";
  for (let i = 0; i < str.length; i++) {
    const c = str[i]!;
    if (c === "\\" && i + 1 < str.length) {
      const n = str[++i]!;
      cur += n === "," ? "," : c + n;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

export const MAX_GLOB_CHARS = 1024;
export const MAX_GLOBS = 64;

/** True when a comma-separated glob param is within the length and pattern-count caps. */
export function globsOk(s: string): boolean {
  return s.length <= MAX_GLOB_CHARS && parseGlobs(s).length <= MAX_GLOBS;
}

/** Keeps paths matching any include glob (all when none) and no exclude glob (Bun.Glob, root-relative paths). */
export function filterByGlobs(files: string[], include: string[], exclude: string[]): string[] {
  if (!include.length && !exclude.length) return files;
  const inc = include.map((g) => new Bun.Glob(g));
  const exc = exclude.map((g) => new Bun.Glob(g));
  return files.filter((f) => (!inc.length || inc.some((g) => g.match(f))) && !exc.some((g) => g.match(f)));
}

/** Drops every path whose realpath is not inside rootReal (symlinked parents, missing files). */
export async function containedOnly(rootReal: string, files: string[]): Promise<string[]> {
  const ok: boolean[] = new Array(files.length).fill(false);
  const CHUNK = 64;
  for (let i = 0; i < files.length; i += CHUNK) {
    await Promise.all(
      files.slice(i, i + CHUNK).map(async (f, j) => {
        ok[i + j] = (await resolveSafe(rootReal, f)) !== null;
      }),
    );
  }
  return files.filter((_, i) => ok[i]);
}

export interface CandidateOptions {
  include?: string | null;
  exclude?: string | null;
  ignored?: boolean;
}

/** Candidate files for a search (containment is enforced per file by the worker): git ls-files in repos, FileIndex otherwise; cached until invalidate(). */
export class Candidates {
  private cached: Promise<string[] | null> | null = null;
  constructor(
    readonly root: string,
    readonly index: FileIndex,
    readonly git: Promise<Git | null>,
  ) {}
  async list(o: CandidateOptions = {}): Promise<string[]> {
    let list: string[] | null = null;
    if (!o.ignored) {
      this.cached ??= this.git.then((g) => g?.listFiles() ?? null).catch(() => null);
      list = await this.cached;
    }
    list ??= (await this.index.get()).split("\n").filter(Boolean);
    return filterByGlobs(list, parseGlobs(o.include), parseGlobs(o.exclude));
  }
  invalidate(): void {
    this.cached = null;
  }
}
