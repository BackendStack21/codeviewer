import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";

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
];

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
    const env = { ...ENV, GIT_ATTR_SOURCE: EMPTY_TREE[format ?? "sha1"] ?? EMPTY_TREE.sha1 };
    return new Git(bin, root, prefix, [...new Set([gitDir, commonDir])], env);
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
      this.git(["log", "-1", "--no-show-signature", "--format=%H%x00%s%x00%an%x00%ct"]),
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

  /** File content at HEAD (raw blob, no filters), or null if the file is not in HEAD. */
  async base(rel: string, maxBytes: number): Promise<Uint8Array | null> {
    const r = await this.git(["cat-file", "blob", `HEAD:./${rel}`], maxBytes);
    return r.code === 0 && !r.truncated ? r.out : null;
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
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return { code: truncated ? 1 : code, out, truncated };
}
