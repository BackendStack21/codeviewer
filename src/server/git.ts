import { watch, type FSWatcher } from "node:fs";
import { HEAVY_DIRS } from "./index.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import { looksBinary, openRegular } from "./files.ts";

/**
 * Read-only git integration via the system `git` CLI.
 *
 * The repository being viewed is untrusted: its .git/config and .gitattributes can name
 * programs (filters, textconv, diff drivers, gpg, fsmonitor). Hardening, layered:
 * - GIT_ATTR_SOURCE = the empty tree: in-tree .gitattributes are ignored, so no path is
 *   bound to a filter/diff driver.
 * - Every filter.* / diff.* driver defined in any config is blanked with -c overrides
 *   (covers $GIT_DIR/info/attributes and global attributes too).
 * - fsmonitor off, signature verification off, no textconv, submodules ignored (their
 *   configs are untrusted too), no external diff, no pager, no prompts.
 * - GIT_OPTIONAL_LOCKS=0: never writes the index or takes locks.
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
export const MAX_CHANGES = 1000;
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

const ENV = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  LC_ALL: "C",
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
  // Counts must not silently turn into "binary" because a config set the threshold to 1.
  "-c", "core.bigFileThreshold=512m",
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
    const r = await run(bin, root, [...HARDEN, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--show-object-format"]);
    if (r.code !== 0) return null;
    const [top, gitDir, common, format] = new TextDecoder().decode(r.out).trim().split("\n");
    if (!top || !gitDir) return null;
    const rel = path.relative(top, root);
    if (rel.startsWith("..")) return null;
    const prefix = rel ? rel.split(path.sep).join("/") + "/" : "";
    const commonDir = common ? path.resolve(root, common) : gitDir;
    const emptyTree = EMPTY_TREE[format ?? "sha1"] ?? EMPTY_TREE.sha1!;
    const env = { ...ENV, GIT_ATTR_SOURCE: emptyTree };
    return new Git(bin, root, prefix, [...new Set([gitDir, commonDir])], env, emptyTree);
  }

  private overrides: Promise<string[]> | null = null;

  /** -c overrides that blank every filter/diff driver any config defines (cached until config changes). */
  private neutralize(): Promise<string[]> {
    return (this.overrides ??= this.computeOverrides());
  }

  private async computeOverrides(): Promise<string[]> {
    const r = await run(this.bin, this.root, [...HARDEN, "config", "--name-only", "--get-regexp", "^(filter|diff|merge)\\."], 1 << 20, this.env);
    const out: string[] = [];
    const drivers = new Set<string>();
    for (const key of new TextDecoder().decode(r.out).split("\n")) {
      const m = /^(filter|diff|merge)\.(.+)\.[^.]+$/.exec(key.trim());
      if (m) drivers.add(`${m[1]}.${m[2]}`);
    }
    for (const d of drivers) {
      if (d.startsWith("filter.")) out.push("-c", `${d}.clean=`, "-c", `${d}.smudge=`, "-c", `${d}.process=`, "-c", `${d}.required=false`);
      else if (d.startsWith("diff.")) out.push("-c", `${d}.textconv=`, "-c", `${d}.command=`);
      else out.push("-c", `${d}.driver=`);
    }
    return out;
  }

  private async git(args: string[], maxBytes = MAX_OUT) {
    return run(this.bin, this.root, [...HARDEN, ...(await this.neutralize()), ...args], maxBytes, this.env);
  }

  /**
   * Tracked plus untracked-but-not-ignored files under the root (root-relative, "/" separated),
   * from `git ls-files -z --cached --others --exclude-standard --deduplicate -- .`; null on failure.
   */
  async listFiles(): Promise<string[] | null> {
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
    const [st, stash, head] = await Promise.all([
      this.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--ignored=traditional", "--ignore-submodules=all", "--", "."]),
      this.git(["rev-list", "--walk-reflogs", "--count", "refs/stash"]),
      this.git(["log", "-1", "--no-show-signature", "--no-mailmap", "--format=%H%x00%s%x00%an%x00%ct"]),
    ]);
    const s: GitStatus = {
      repo: true, branch: null, detached: false, oid: null, upstream: null, ahead: 0, behind: 0,
      state: this.opState(), stash: 0, files: {}, head: null,
    };
    if (stash.code === 0) s.stash = Number(new TextDecoder().decode(stash.out).trim()) || 0;
    if (head.code === 0) {
      const [hash, subject, author, time] = new TextDecoder().decode(head.out).trim().split("\0");
      if (hash) s.head = { hash, subject: subject ?? "", author: author ?? "", time: Number(time) * 1000 };
    }
    if (st.code !== 0) return s;

    const recs = new TextDecoder().decode(st.out).split("\0");
    const add = (p: string, xy: string) => {
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
    const has = (f: string) => this.gitDirs.some((d) => existsSync(path.join(d, f)));
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
   * upstream. `same` means the merge-base is HEAD itself (nothing committed on top of the base).
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
    for (const n of BASE_NAMES) if (n !== branch) refs.push(`refs/heads/${n}`);
    if (upstream.startsWith("refs/remotes/") && !refs.includes(upstream)) refs.push(upstream);
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
      "diff", "--raw", "--numstat", "-z", "-M", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "-O/dev/null", rev, "--", ".",
    ]);
    if (r.code !== 0) return { files: [], truncated: false };
    const recs = new TextDecoder().decode(r.out).split("\0");
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
    if (r.code !== 0) return { files: [], truncated: false };
    const all = new TextDecoder()
      .decode(r.out)
      .split("\0")
      .filter((f) => f && !f.split("/").some((seg) => HEAVY_DIRS.has(seg)));
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
      const { fh, st } = await openRegular(path.join(this.root, ...e.path.split("/")));
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
    const r = await this.git(["blame", "--porcelain", "--no-textconv", "-L", `${line},${line}`, "--", rel], 1 << 20);
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

  /** Schedules a debounced status refresh (at least 2× the last run's duration apart). */
  poke() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      const t0 = performance.now();
      const s = await this.status();
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

/** n-th space-separated field to the end of the record (paths may contain spaces). */
function field(rec: string, n: number): string {
  let idx = 0;
  for (let i = 0; i < n; i++) idx = rec.indexOf(" ", idx) + 1;
  return rec.slice(idx);
}

async function run(bin: string, cwd: string, args: string[], maxBytes = MAX_OUT, env: Record<string, string | undefined> = ENV) {
  const p = Bun.spawn([bin, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
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
