import { watch, type FSWatcher } from "node:fs";
import { HEAVY_DIRS } from "./index.ts";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { looksBinary, openRegular } from "./files.ts";

/**
 * Read-only git integration via the system `git` CLI.
 *
 * The repository being viewed is untrusted: its .git/config and .gitattributes can name
 * programs (filters, textconv, diff drivers, gpg, fsmonitor). Hardening, layered:
 * - GIT_ATTR_SOURCE = the empty tree: in-tree .gitattributes are ignored, so no path is
 *   bound to a filter/diff driver.
 * - Every filter.* / diff.* / merge.* driver defined in any config is blanked through
 *   GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n (covers $GIT_DIR/info/attributes and global
 *   attributes too). Not `-c key=value`: git splits that at the first "=", so a driver
 *   named "a=b" would survive as `filter.a = "b.clean="` with the real driver still armed.
 * - fsmonitor off, signature verification off, no textconv, submodules ignored (their
 *   configs are untrusted too), no external diff, no pager, no prompts.
 * - GIT_OPTIONAL_LOCKS=0: never writes the index or takes locks.
 * - No transport at all (GIT_ALLOW_PROTOCOL empty, GIT_NO_LAZY_FETCH): a partial clone fetches
 *   missing blobs from its promisor remote on demand, and the remote's config names programs
 *   (remote.*.uploadpack, core.sshCommand). The environment variable wins over any
 *   protocol.*.allow a hostile config sets.
 * Every argument is passed as an array (no shell).
 */

export interface GitStatus {
  repo: true;
  branch: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** In-progress operation: merge, rebase, cherry-pick, revert, bisect. */
  state: string | null;
  stash: number;
  /** root-relative path → porcelain XY (e.g. ".M", "A.", "??", "!!", "UU"). Dirs end with "/". */
  files: Record<string, string>;
  /** The viewed folder is itself git-ignored (git lists only the folder, so `files` has no "!!" entries). */
  rootIgnored: boolean;
  head: { hash: string; subject: string; author: string; time: number } | null;
}

export interface BlameLine {
  hash: string;
  author: string;
  mail: string;
  time: number;
  summary: string;
  you: boolean;
  uncommitted: boolean;
}

/** One changed file in a Changes listing. `status` is git's raw letter; "?" = untracked. */
export interface ChangeEntry {
  /** root-relative, "/" separated */
  path: string;
  /** Previous path of a rename or copy. */
  oldPath?: string;
  status: "M" | "A" | "D" | "R" | "C" | "T" | "U" | "X" | "?";
  /** Lines added/removed; null for binary files and files that were not counted. */
  added: number | null;
  removed: number | null;
  binary: boolean;
}

export interface Changes {
  scope: "head" | "branch";
  /** The base branch comparison, or null when no base branch could be found. */
  base: { name: string; oid: string; mergeBase: string; same: boolean } | null;
  /** Commit the working tree is compared with: HEAD, or the merge-base in branch scope. Null on an unborn branch. */
  rev: string | null;
  files: ChangeEntry[];
  /** The file list was cut at MAX_CHANGES entries. */
  truncated: boolean;
  /** Commits between the merge-base and HEAD (branch scope only), and up to 20 of their subjects. */
  commits: number;
  subjects: string[];
}

/** Most entries a Changes listing carries (tracked diffs and untracked files each). */
export interface HistoryEntry {
  oid: string;
  /** First parent; null for a root commit. */
  parent: string | null;
  author: string;
  /** Author time, ms since the epoch. */
  time: number;
  subject: string;
  /** Root-relative path of the file in this commit. */
  path: string;
  /** Its path before this commit, when the commit renamed or copied it. */
  oldPath?: string;
  status: "M" | "A" | "D" | "R" | "C" | "T";
}

export const MAX_CHANGES = 1000;
/** Commits listed by File History at most. */
export const MAX_HISTORY = 500;
/** Untracked files whose lines are counted (the rest show no counts). */
const COUNT_UNTRACKED = 200;
const COUNT_MAX_BYTES = 1 << 20;
/** Local branches tried as the base when the remote has no HEAD. */
const BASE_NAMES = ["main", "master", "develop", "trunk"];
const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** True for a full hex object id (the only form of revision the HTTP layer accepts). */
export function isOid(s: string): boolean {
  return OID.test(s);
}

/**
 * Variables that would point git at another repository than the one under the viewed folder (set
 * when codeviewer is started from a git hook, or by the user's shell): discovery is by the folder only.
 */
const LOCATORS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CONFIG", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE"];

const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !LOCATORS.includes(k))),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  LC_ALL: "C",
  GIT_ALLOW_PROTOCOL: "",
  GIT_NO_LAZY_FETCH: "1",
};

const HARDEN = [
  "-c", "core.fsmonitor=false",
  "-c", "core.quotepath=off",
  "-c", "diff.external=",
  "-c", "color.ui=false",
  "-c", "log.showSignature=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "submodule.recurse=false",
  "-c", "status.submoduleSummary=false",
  // A mailmap file is read whole by log/blame: a hostile config can point it at /dev/zero.
  "-c", "mailmap.file=/dev/null",
  "-c", "mailmap.blob=",
  "-c", "log.mailmap=false",
  // Also read whole; `log --follow` ignores `-O`, so the order file is overridden as config too.
  "-c", "diff.orderFile=/dev/null",
  // Counts must not silently turn into "binary" because a config set the threshold to 1.
  "-c", "core.bigFileThreshold=512m",
  // A submodule is a repository with its own (untrusted) config, which the overrides below never
  // read: git must not look inside one (diff ran `git status` in it, and its filters).
  "-c", "diff.ignoreSubmodules=all",
  // Unlimited rename detection (renameLimit=0) took 52 s on 15 000 renames, past the run timeout,
  // so Changes and status came back empty.
  "-c", "diff.renameLimit=1000",
  "-c", "status.renameLimit=1000",
  // Commit text in UTF-8, whatever the repository asks for (UTF-16 broke every parser).
  "-c", "i18n.logOutputEncoding=UTF-8",
  // `git diff` rewrites the index to refresh stat info (it ignores GIT_OPTIONAL_LOCKS), and
  // writing the index runs the repository's own post-index-change hook: an extracted tarball with
  // touched files ran it from the Changes view. No refresh (diffFiles copes), and no hooks at all.
  "-c", "diff.autoRefreshIndex=false",
  "-c", "core.hooksPath=/dev/null",
];

/** Wall clock for one git run; a hostile config can make git read /dev/zero forever. */
const RUN_TIMEOUT_MS = 30_000;

/** Empty tree ids (always known to git, even if absent from the object store). */
const EMPTY_TREE: Record<string, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

const MAX_OUT = 32 * 1024 * 1024;

export class Git {
  private last = "";
  private running: Promise<GitStatus> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchers: FSWatcher[] = [];
  private email: Promise<string> | null = null;

  private constructor(
    private bin: string,
    readonly root: string,
    /** root's path inside the repo ("" or "sub/dir/") */
    private prefix: string,
    private gitDirs: string[],
    private env: Record<string, string | undefined>,
    /** The empty tree of this repository's object format (the diff base of an unborn branch). */
    private emptyTree: string,
  ) {}

  static async open(root: string): Promise<Git | null> {
    const bin = Bun.which("git");
    if (!bin) return null;
    // Even rev-parse reads .git/config, HEAD and commondir to their end: check them first.
    if (!preflight(root)) return null;
    const r = await run(bin, root, [...HARDEN, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--show-object-format"]);
    if (r.code !== 0) return null;
    const [top, gitDir, common, format] = new TextDecoder().decode(r.out).trim().split("\n");
    if (!top || !gitDir) return null;
    const rel = path.relative(top, root);
    // Outside the work tree ("..", "../x"); a folder merely named "..x" is inside it.
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
    const prefix = rel ? rel.split(path.sep).join("/") + "/" : "";
    const commonDir = common ? path.resolve(root, common) : gitDir;
    const emptyTree = EMPTY_TREE[format ?? "sha1"] ?? EMPTY_TREE.sha1!;
    const env = { ...ENV, GIT_ATTR_SOURCE: emptyTree };
    return new Git(bin, root, prefix, [...new Set([gitDir, commonDir])], env, emptyTree);
  }

  private overrides: Promise<Record<string, string | undefined> | null> | null = null;

  /**
   * The run environment, with every filter/diff/merge driver any config defines blanked; null when
   * the drivers could not be listed, and then no git call runs. Shared by the calls of one
   * operation and recomputed for the next (fresh()): a config can include files the watcher does
   * not see (a tracked file via include.path, ~/.gitconfig), and a driver added there must not run.
   */
  private neutralize(): Promise<Record<string, string | undefined> | null> {
    return (this.overrides ??= this.computeOverrides());
  }

  /** Starts an operation: the overrides are listed again before its first git call. */
  private fresh() {
    this.overrides = null;
  }

  private async computeOverrides(): Promise<Record<string, string | undefined> | null> {
    // Re-checked for every operation: the repository can change while it is open.
    if (!this.gitDirs.every(gitDirFilesOk)) return null;
    const r = await run(this.bin, this.root, [...HARDEN, "config", "--name-only", "-z", "--get-regexp", "^(filter|diff|merge)\\."], 16 << 20, this.env);
    // Fail closed: a cut-off or failed listing would leave every driver after the cut armed.
    // (Exit code 1 means no driver is defined.)
    if (r.truncated || (r.code !== 0 && r.code !== 1)) return null;
    const pairs: [string, string][] = [];
    const drivers = new Set<string>();
    // NUL separated (-z): a key is never split, whatever its subsection holds.
    for (const key of new TextDecoder().decode(r.out).split("\0")) {
      const m = /^(filter|diff|merge)\.(.+)\.[^.]+$/s.exec(key);
      if (m) drivers.add(`${m[1]}.${m[2]}`);
    }
    for (const d of drivers) {
      if (d.startsWith("filter.")) pairs.push([`${d}.clean`, ""], [`${d}.smudge`, ""], [`${d}.process`, ""], [`${d}.required`, "false"]);
      else if (d.startsWith("diff.")) pairs.push([`${d}.textconv`, ""], [`${d}.command`, ""]);
      else pairs.push([`${d}.driver`, ""]);
    }
    // Command-line-level config (same precedence as -c), but key and value travel separately.
    // Appended after any entries the user's own environment carries.
    const from = Math.max(0, Number(this.env.GIT_CONFIG_COUNT) || 0);
    const env: Record<string, string | undefined> = { ...this.env, GIT_CONFIG_COUNT: String(from + pairs.length) };
    pairs.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${from + i}`] = k;
      env[`GIT_CONFIG_VALUE_${from + i}`] = v;
    });
    return env;
  }

  private async git(args: string[], maxBytes = MAX_OUT) {
    const env = await this.neutralize();
    if (!env) return { code: 1, out: new Uint8Array(0), truncated: false };
    return run(this.bin, this.root, [...HARDEN, ...args], maxBytes, env);
  }

  /**
   * Tracked plus untracked-but-not-ignored files under the root (root-relative, "/" separated),
   * from `git ls-files -z --cached --others --exclude-standard --deduplicate -- .`; null on failure.
   */
  async listFiles(): Promise<string[] | null> {
    this.fresh();
    const r = await this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate", "--", "."]);
    if (r.code !== 0) return null;
    return new TextDecoder().decode(r.out).split("\0").filter((f) => f && !f.split("/").some((seg) => HEAVY_DIRS.has(seg)));
  }

  /** Current status; concurrent callers share one `git status` run. */
  status(): Promise<GitStatus> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.compute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async compute(): Promise<GitStatus> {
    this.fresh();
    const [st, stash, head] = await Promise.all([
      this.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--ignored=traditional", "--ignore-submodules=all", "--", "."]),
      this.git(["rev-list", "--walk-reflogs", "--count", "refs/stash"]),
      this.git(["log", "-1", "--no-show-signature", "--no-mailmap", "--format=%H%x00%s%x00%an%x00%ct"]),
    ]);
    const s: GitStatus = {
      repo: true, branch: null, detached: false, oid: null, upstream: null, ahead: 0, behind: 0,
      state: this.opState(), stash: 0, files: {}, rootIgnored: false, head: null,
    };
    if (stash.code === 0) s.stash = Number(new TextDecoder().decode(stash.out).trim()) || 0;
    if (head.code === 0) {
      const [hash, subject, author, time] = new TextDecoder().decode(head.out).trim().split("\0");
      if (hash) s.head = { hash, subject: subject ?? "", author: author ?? "", time: Number(time) * 1000 };
    }
    if (st.code !== 0) return s;

    const recs = new TextDecoder().decode(st.out).split("\0");
    const add = (p: string, xy: string) => {
      // The viewed subfolder itself: status collapses an ignored folder into one "!! sub/" record.
      if (this.prefix && (p === this.prefix || p + "/" === this.prefix)) {
        if (xy === "!!") s.rootIgnored = true;
        return;
      }
      if (!p.startsWith(this.prefix)) return;
      const rel = p.slice(this.prefix.length);
      if (rel) s.files[rel] = xy;
    };
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]!;
      if (!r) continue;
      if (r.startsWith("# ")) {
        const [, key, ...rest] = r.split(" ");
        const val = rest.join(" ");
        if (key === "branch.oid") s.oid = val === "(initial)" ? null : val;
        else if (key === "branch.head") {
          s.detached = val === "(detached)";
          s.branch = s.detached ? null : val;
        } else if (key === "branch.upstream") s.upstream = val;
        else if (key === "branch.ab") {
          const m = /\+(\d+) -(\d+)/.exec(val);
          if (m) {
            s.ahead = Number(m[1]);
            s.behind = Number(m[2]);
          }
        }
        continue;
      }
      const kind = r[0];
      if (kind === "1") add(field(r, 8), r.slice(2, 4));
      else if (kind === "2") {
        add(field(r, 9), r.slice(2, 4));
        i++; // the original path of a rename/copy follows as its own record
      } else if (kind === "u") add(field(r, 10), "UU");
      else if (kind === "?") add(r.slice(2), "??");
      else if (kind === "!") add(r.slice(2), "!!");
    }
    return s;
  }

  private opState(): string | null {
    // Operation markers are per worktree: only this worktree's git dir, never the common dir
    // (a merge in the main checkout must not show as "merging" in a linked worktree).
    const has = (f: string) => existsSync(path.join(this.gitDirs[0]!, f));
    if (has("rebase-merge") || has("rebase-apply")) return "rebasing";
    if (has("MERGE_HEAD")) return "merging";
    if (has("CHERRY_PICK_HEAD")) return "cherry-picking";
    if (has("REVERT_HEAD")) return "reverting";
    if (has("BISECT_LOG")) return "bisecting";
    return null;
  }

  /**
   * File content at HEAD (raw blob, no filters), or null if the file is not in HEAD.
   * `rev` (a full object id) reads the file as of that commit instead.
   */
  async base(rel: string, maxBytes: number, rev = "HEAD"): Promise<Uint8Array | null> {
    this.fresh();
    if (rev !== "HEAD" && !isOid(rev)) return null;
    const r = await this.git(["cat-file", "blob", `${rev}:./${rel}`], maxBytes);
    return r.code === 0 && !r.truncated ? r.out : null;
  }

  // ───────────────────────────── changes ─────────────────────────────

  private async rev(...args: string[]): Promise<string | null> {
    const r = await this.git(["rev-parse", "-q", "--verify", ...args], 1 << 16);
    const s = new TextDecoder().decode(r.out).trim();
    return r.code === 0 && s ? s : null;
  }

  /**
   * The branch this one is reviewed against: the remote's default branch (origin/HEAD), else
   * the first of main/master/develop/trunk that exists and is not the current branch, else the
   * upstream. On one of those branches itself the upstream comes first: a stale local `master`
   * must not win over `origin/main`. `same` means the merge-base is HEAD itself (nothing
   * committed on top of the base).
   */
  async detectBase(headOid: string): Promise<Changes["base"]> {
    const dec = (r: { code: number; out: Uint8Array }) => (r.code === 0 ? new TextDecoder().decode(r.out).trim() : "");
    const [branch, originHead, upstream] = await Promise.all([
      this.git(["symbolic-ref", "-q", "--short", "HEAD"], 1 << 16).then(dec),
      this.git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], 1 << 16).then(dec),
      this.git(["rev-parse", "-q", "--symbolic-full-name", "@{upstream}"], 1 << 16).then(dec),
    ]);
    const refs: string[] = [];
    if (originHead.startsWith("refs/remotes/")) refs.push(originHead);
    const up = upstream.startsWith("refs/remotes/") ? upstream : "";
    if (up && BASE_NAMES.includes(branch)) refs.push(up);
    for (const n of BASE_NAMES) if (n !== branch) refs.push(`refs/heads/${n}`);
    if (up && !refs.includes(up)) refs.push(up);
    for (const ref of refs) {
      const oid = await this.rev(`${ref}^{commit}`);
      if (!oid) continue;
      const mergeBase = dec(await this.git(["merge-base", headOid, oid], 1 << 16));
      if (!isOid(mergeBase)) continue; // unrelated histories
      return { name: ref.replace(/^refs\/(heads|remotes)\//, ""), oid, mergeBase, same: mergeBase === headOid };
    }
    return null;
  }

  private inflight: Partial<Record<"head" | "branch", Promise<Changes>>> = {};

  /**
   * Files changed in the working tree against HEAD ("head") or against the merge-base with the
   * base branch ("branch", which therefore includes uncommitted work), plus untracked files.
   * Concurrent callers of the same scope share one run.
   */
  changes(scope: "head" | "branch"): Promise<Changes> {
    return (this.inflight[scope] ??= this.computeChanges(scope).finally(() => {
      delete this.inflight[scope];
    }));
  }

  private async computeChanges(scope: "head" | "branch"): Promise<Changes> {
    this.fresh();
    const headOid = await this.rev("HEAD^{commit}");
    const base = headOid ? await this.detectBase(headOid) : null;
    const branch = scope === "branch" && !!base && !base.same;
    // An unborn branch (no commits yet) diffs against the empty tree, so staged files show as added.
    const rev = branch ? base!.mergeBase : headOid ?? this.emptyTree;
    const [tracked, untracked, unmerged] = await Promise.all([this.diffFiles(rev), this.untracked(), this.unmerged()]);
    const byPath = new Map(tracked.files.map((e) => [e.path, e]));
    for (const u of untracked.files) {
      const t = byPath.get(u.path);
      // Deleted from the index but present on disk (git rm --cached): one entry, as a modification.
      if (t) Object.assign(t, { status: "M", added: null, removed: null, binary: u.binary });
      else byPath.set(u.path, u);
    }
    for (const p of unmerged) {
      const t = byPath.get(p);
      if (t) t.status = "U";
      else byPath.set(p, { path: p, status: "U", added: null, removed: null, binary: false });
    }
    const files = [...byPath.values()];
    let commits = 0;
    let subjects: string[] = [];
    if (branch) {
      const [n, log] = await Promise.all([
        this.git(["rev-list", "--count", `${base!.mergeBase}..${headOid}`], 1 << 16),
        this.git(["log", "-z", "--no-show-signature", "--no-mailmap", "--format=%s", "-n", "20", `${base!.mergeBase}..${headOid}`], 1 << 20),
      ]);
      if (n.code === 0) commits = Number(new TextDecoder().decode(n.out).trim()) || 0;
      if (log.code === 0) subjects = new TextDecoder().decode(log.out).split("\0").map((s) => s.trim()).filter(Boolean);
    }
    return { scope: branch ? "branch" : "head", base, rev: headOid ? rev : null, files, truncated: tracked.truncated || untracked.truncated, commits, subjects };
  }

  /**
   * `git diff --raw --numstat` of the working tree against `rev`, restricted to the viewed folder.
   * Hostile configs are neutralized: no order file (read whole), paths never cwd-relative.
   */
  private async diffFiles(rev: string): Promise<{ files: ChangeEntry[]; truncated: boolean }> {
    const r = await this.git([
      "diff", "--raw", "--numstat", "-z", "-M", "--no-abbrev", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--ignore-submodules=all", "-O/dev/null", rev, "--", ".",
    ]);
    // A run cut by the timeout or the size cap is an incomplete list, not a clean tree.
    if (r.code !== 0) return { files: [], truncated: r.truncated };
    const recs = new TextDecoder().decode(r.out).split("\0");
    const statOnly = new Map<ChangeEntry, string>();
    const byPath = new Map<string, ChangeEntry>();
    let truncated = false;
    const strip = (p: string) => (p.startsWith(this.prefix) ? p.slice(this.prefix.length) : null);
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i]!;
      if (!rec) continue;
      if (rec[0] === ":") {
        // raw: ":srcmode dstmode sha sha STATUS[score]" then the path record(s)
        const parts = rec.slice(1).split(" ");
        const st = parts[4]?.[0] ?? "M";
        const two = st === "R" || st === "C";
        const oldP = two ? recs[++i] ?? "" : "";
        const newP = recs[++i] ?? "";
        if (parts[0] === "160000" || parts[1] === "160000") continue; // submodules: nothing to diff here
        const rel = strip(newP);
        if (rel === null || !rel) continue;
        if (byPath.size >= MAX_CHANGES) {
          truncated = true;
          continue; // keep consuming: the numstat records of kept entries follow
        }
        const status = (/^[MADRCTUX]$/.test(st) ? st : "M") as ChangeEntry["status"];
        const e: ChangeEntry = { path: rel, status, added: null, removed: null, binary: false };
        // Kept for the stat-only check below (not part of the entry sent to the client).
        if (status === "M" && parts[0] === parts[1]) statOnly.set(e, parts[2] ?? "");
        if (two) {
          const o = strip(oldP);
          // A rename from outside the viewed folder: show it as new, never a path above the root.
          if (o) e.oldPath = o;
          else e.status = "A";
        }
        byPath.set(rel, e);
        continue;
      }
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(rec);
      if (!m) continue;
      let p = m[3]!;
      if (!p) {
        i++; // rename: old path, then new path
        p = recs[++i] ?? "";
      }
      const rel = strip(p);
      const e = rel ? byPath.get(rel) : undefined;
      if (!e) continue;
      if (m[1] === "-") e.binary = true;
      else {
        e.added = Number(m[1]);
        e.removed = Number(m[2]);
      }
    }
    // Without an index refresh, files whose stat info changed but whose content did not are listed
    // as modified: a text file then has no numstat line, a binary one "-\t-". Drop the first, and
    // hash the second (hash-object reads, never writes) to compare with the blob it came from.
    const binaries: ChangeEntry[] = [];
    for (const [e, oid] of statOnly) {
      if (e.added === null && !e.binary) byPath.delete(e.path);
      else if (e.binary && isOid(oid)) binaries.push(e);
    }
    for (let i = 0; i < binaries.length && i < 400; i += 100) {
      const chunk = binaries.slice(i, i + 100);
      const h = await this.git(["hash-object", "--no-filters", "--", ...chunk.map((e) => e.path)], 1 << 16);
      if (h.code !== 0) continue;
      const oids = new TextDecoder().decode(h.out).trim().split("\n");
      chunk.forEach((e, n) => {
        if (oids[n] === statOnly.get(e)) byPath.delete(e.path);
      });
    }
    return { files: [...byPath.values()], truncated };
  }

  /** Paths with unresolved merge conflicts (root-relative): `git diff <commit>` never reports them. */
  private async unmerged(): Promise<string[]> {
    const r = await this.git(["ls-files", "-z", "--unmerged", "--", "."], 1 << 22);
    if (r.code !== 0) return [];
    const out = new Set<string>();
    for (const rec of new TextDecoder().decode(r.out).split("\0")) {
      const tab = rec.indexOf("\t");
      if (tab > 0) out.add(rec.slice(tab + 1));
    }
    return [...out];
  }

  /** Untracked, not ignored files under the root, with line counts for the first few text files. */
  private async untracked(): Promise<{ files: ChangeEntry[]; truncated: boolean }> {
    const r = await this.git(["ls-files", "-z", "--others", "--exclude-standard", "--", "."]);
    // A run cut by the timeout or the size cap is an incomplete list, not a clean tree.
    if (r.code !== 0) return { files: [], truncated: r.truncated };
    // A nested repository is listed as "dir/": not a file, nothing to count or diff.
    const all = new TextDecoder()
      .decode(r.out)
      .split("\0")
      .filter((f) => f && !f.endsWith("/") && !f.split("/").some((seg) => HEAVY_DIRS.has(seg)));
    const paths = all.slice(0, MAX_CHANGES);
    const files: ChangeEntry[] = paths.map((p) => ({ path: p, status: "?", added: null, removed: null, binary: false }));
    // A few files at a time through one 64 KiB buffer each: never 200 MiB of buffers per request.
    const queue = files.slice(0, COUNT_UNTRACKED);
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let e = queue.shift(); e; e = queue.shift()) await this.countLines(e);
    }));
    return { files, truncated: all.length > MAX_CHANGES };
  }

  private async countLines(e: ChangeEntry) {
    try {
      const { fh, st } = await openRegular(path.join(this.root, ...e.path.split("/")), this.root);
      try {
        if (st.size > COUNT_MAX_BYTES) return;
        const buf = new Uint8Array(64 * 1024);
        let n = 0;
        let last = 10;
        let total = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, total);
          if (!bytesRead) break;
          if (total === 0 && looksBinary(buf.subarray(0, bytesRead))) {
            e.binary = true;
            return;
          }
          for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) n++;
          last = buf[bytesRead - 1]!;
          total += bytesRead;
        }
        if (total && last !== 10) n++;
        e.added = n;
        e.removed = 0;
      } finally {
        await fh.close();
      }
    } catch {}
  }

  async blame(rel: string, line: number): Promise<BlameLine | null> {
    this.fresh();
    // --no-ignore-revs-file: blame.ignoreRevsFile from a hostile config (a missing file fails every
    // blame, /dev/zero reads forever). `-c blame.ignoreRevsFile=` does not reset it: the empty value
    // sorts first among the configured ones. A repository's real ignore list is not applied either.
    const r = await this.git(["blame", "--porcelain", "--no-textconv", "--no-ignore-revs-file", "-L", `${line},${line}`, "--", rel], 1 << 20);
    if (r.code !== 0) return null;
    const out = new TextDecoder().decode(r.out).split("\n");
    const hash = out[0]?.split(" ")[0] ?? "";
    const get = (k: string) => out.find((l) => l.startsWith(k + " "))?.slice(k.length + 1) ?? "";
    const mail = get("author-mail").replace(/[<>]/g, "");
    this.email ??= this.git(["config", "user.email"]).then((x) => new TextDecoder().decode(x.out).trim());
    const uncommitted = /^0+$/.test(hash);
    return {
      hash,
      author: get("author"),
      mail,
      time: Number(get("author-time")) * 1000,
      summary: get("summary"),
      you: uncommitted || (!!mail && mail === (await this.email)),
      uncommitted,
    };
  }

  /**
   * The commits that changed one file, newest first, following renames (`git log --follow`).
   * Merges are compared with their first parent. Paths are root-relative; history from before
   * the file was renamed into the root from outside it ends at that rename (shown as added).
   */
  async history(rel: string): Promise<HistoryEntry[] | null> {
    this.fresh();
    // --root: the commit that added the file is listed even under log.showRoot=false.
    const args = ["--literal-pathspecs", "log", "--follow", "--root", "-z", "-M", "--no-color", "--no-decorate", "--no-show-signature", "--no-ext-diff", "--no-textconv", "--no-relative",
      "--name-status", "--format=%H%x00%P%x00%an%x00%at%x00%s", `-n${MAX_HISTORY}`];
    // --diff-merges needs git 2.31; older ones list merges without files (they are skipped then).
    let r = await this.git([...args, "--diff-merges=first-parent", "--", rel], 4 << 20);
    if (r.code !== 0 && !r.truncated) r = await this.git([...args, "--", rel], 4 << 20);
    if (r.code !== 0) return null;
    return parseHistory(new TextDecoder().decode(r.out), this.prefix);
  }

  /**
   * Calls `onChange` with fresh status whenever it actually changes: after worktree edits
   * (call `poke()`) and after anything in .git that matters (index, HEAD, refs, ops).
   */
  watch(onChange: (s: GitStatus) => void) {
    const relevant = /^(index|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG|packed-refs|refs[\\/]|logs[\\/]refs[\\/]stash|rebase-merge|rebase-apply)/;
    for (const dir of this.gitDirs) {
      try {
        const w = watch(dir, { recursive: true, persistent: false }, (_e, f) => {
          const name = String(f ?? "");
          if (/^config(\.worktree)?$/.test(name)) {
            this.overrides = null;
            this.poke();
          } else if (!name.endsWith(".lock") && relevant.test(name)) this.poke();
        });
        w.on("error", () => {});
        this.watchers.push(w);
      } catch {}
    }
    this.onChange = onChange;
  }

  private onChange: ((s: GitStatus) => void) | null = null;

  /** Duration of the last `git status`, to back off on huge or stat-dirty repositories. */
  private lastMs = 0;

  /** Schedules a status refresh, throttled (at least 2× the last run's duration apart). */
  poke() {
    // Already scheduled: keep that time. Restarting the wait on every poke meant a file written
    // more often than every 200 ms (a log) held the status back for as long as it was written.
    if (this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      const t0 = performance.now();
      const s = await this.status().catch(() => null);
      if (!s) return;
      this.lastMs = performance.now() - t0;
      if (this.again) {
        this.again = false;
        this.poke();
      }
      const key = JSON.stringify(s);
      if (key !== this.last) {
        this.last = key;
        this.onChange?.(s);
      }
    }, Math.max(200, Math.min(10_000, this.lastMs * 2)));
  }

  stop() {
    for (const w of this.watchers) w.close();
    if (this.timer) clearTimeout(this.timer);
  }
}

/**
 * Parses `log -z --name-status --format=%H%x00%P%x00%an%x00%at%x00%s`. The output is read as NUL
 * separated tokens by position: a header of five fields, then status/path records until the next
 * object id. Subjects and paths come from the repository and are never used as separators.
 */
export function parseHistory(out: string, prefix = ""): HistoryEntry[] {
  const t = out.split("\0");
  const res: HistoryEntry[] = [];
  const strip = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : null);
  let i = 0;
  while (i < t.length && res.length < MAX_HISTORY) {
    const oid = t[i]!.replace(/^\n/, "");
    if (!isOid(oid) || i + 4 >= t.length) {
      i++;
      continue;
    }
    const [parents, author, at, subject] = [t[i + 1]!, t[i + 2]!, t[i + 3]!, t[i + 4]!];
    i += 5;
    let entry: HistoryEntry | null = null;
    for (let m; i < t.length && (m = /^\n?([MADRCTUX])\d*$/.exec(t[i]!)); ) {
      const st = m[1]!;
      const two = st === "R" || st === "C";
      const oldP = two ? (t[i + 1] ?? "") : "";
      const newP = t[i + (two ? 2 : 1)] ?? "";
      i += two ? 3 : 2;
      const p = strip(newP);
      if (entry || !p) continue; // --follow lists one file per commit; anything else is ignored
      const status = (/^[MADRCT]$/.test(st) ? st : "M") as HistoryEntry["status"];
      entry = { oid, parent: parents.split(" ")[0] || null, author, time: Number(at) * 1000, subject, path: p, status };
      if (two) {
        const o = strip(oldP);
        if (o) entry.oldPath = o;
        else entry.status = "A"; // renamed in from outside the viewed folder
      }
    }
    if (entry) res.push(entry);
  }
  return res;
}

/**
 * Files git reads whole, and the most each may hold. A symlink to /dev/zero or a FIFO in their
 * place made git allocate until memory ran out (or block for the 30 s run timeout), and no config
 * key prevents those reads: each must be a regular file of a sane size, or git is not used at all.
 */
const GIT_FILES: [string, number][] = [
  ["HEAD", 1 << 20], ["commondir", 1 << 16], ["gitdir", 1 << 16], ["shallow", 64 << 20], ["config", 16 << 20],
  ["config.worktree", 16 << 20], ["info/attributes", 16 << 20], ["info/exclude", 16 << 20], ["info/grafts", 16 << 20],
  ["info/sparse-checkout", 16 << 20], ["objects/info/alternates", 1 << 20], ["objects/info/commit-graphs/commit-graph-chain", 1 << 20],
  ["packed-refs", 2 ** 30], ["index", 4 * 2 ** 30], ["sharedindex", 4 * 2 ** 30], // not `4 << 30`: that overflows to 0
];

/** True when every file of GIT_FILES that exists in `dir` is a regular file within its size. */
export function gitDirFilesOk(dir: string): boolean {
  for (const [name, max] of GIT_FILES) {
    let st;
    try {
      st = lstatSync(path.join(dir, ...name.split("/")));
    } catch {
      continue; // absent: fine
    }
    if (!st.isFile() || st.size > max) return false;
  }
  return true;
}

/**
 * Before git runs at all: the `.git` it will find for `root` (walking up; a `gitdir:` file followed),
 * its common dir, and their files must all be safe to read. False refuses git for this folder.
 */
function preflight(root: string): boolean {
  for (let d = root; ; d = path.dirname(d)) {
    const dotgit = path.join(d, ".git");
    let st;
    try {
      st = lstatSync(dotgit);
    } catch {
      if (path.dirname(d) === d) return true; // no repository: nothing for git to read
      continue;
    }
    let gitDir = dotgit;
    if (!st.isDirectory()) {
      // A worktree's `.git` file: small and regular (a FIFO or /dev/zero in its place is refused).
      if (!st.isFile() || st.size > 4096) return false;
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, "utf8"));
      if (!m) return true; // not a repository git recognises; it will say so itself
      gitDir = path.resolve(d, m[1]!);
    }
    if (!gitDirFilesOk(gitDir)) return false;
    let common = "";
    try {
      common = readFileSync(path.join(gitDir, "commondir"), "utf8").trim(); // checked above: small, regular
    } catch {}
    return !common || gitDirFilesOk(path.resolve(gitDir, common));
  }
}

/** n-th space-separated field to the end of the record (paths may contain spaces). */
function field(rec: string, n: number): string {
  let idx = 0;
  for (let i = 0; i < n; i++) idx = rec.indexOf(" ", idx) + 1;
  return rec.slice(idx);
}

async function run(bin: string, cwd: string, args: string[], maxBytes = MAX_OUT, env: Record<string, string | undefined> = ENV) {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn([bin, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    // The viewed folder was deleted (spawn fails on a missing cwd), or git was removed: a failed
    // run, never a throw (from a status refresh timer it was an unhandled rejection: exit 1).
    return { code: 1, out: new Uint8Array(0), truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const timer = setTimeout(() => {
    truncated = true;
    p.kill();
  }, RUN_TIMEOUT_MS);
  const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    if (size + r.value.length > maxBytes) {
      truncated = true;
      p.kill();
      break;
    }
    chunks.push(r.value);
    size += r.value.length;
  }
  const code = await p.exited;
  clearTimeout(timer);
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return { code: truncated ? 1 : code, out, truncated };
}
