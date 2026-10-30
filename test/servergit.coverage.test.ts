import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git, type GitStatus } from "../src/server/git.ts";

let dir = "";
let repo = "";
const open: Git[] = [];

const sh = (cmd: string[], cwd = repo) => {
  const r = Bun.spawnSync(["git", ...cmd], { cwd, stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};
const commit = (msg: string) => sh(["-c", "user.name=Tester", "-c", "user.email=t@example.com", "commit", "-qm", msg]);
async function until(cond: () => boolean, ms = 10000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await Bun.sleep(30);
  }
}
async function git(root = repo) {
  const g = (await Git.open(root))!;
  open.push(g);
  return g;
}

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-gitcov-")));
  repo = path.join(dir, "repo");
  await mkdir(repo);
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.email", "t@example.com"]);
  sh(["config", "user.name", "Tester"]);
  await writeFile(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  await mkdir(path.join(repo, "sub"));
  await writeFile(path.join(repo, "sub", "s.txt"), "s\n");
  await writeFile(path.join(repo, "old name.txt"), "rename me, I am long enough to be detected as a rename\nline2\nline3\n");
  sh(["add", "."]);
  commit("init");
});
afterAll(async () => {
  for (const g of open) g.stop();
  await rm(dir, { recursive: true, force: true });
});

test("open returns null outside a repository", async () => {
  const plain = await mkdtemp(path.join(tmpdir(), "cv-nogit-"));
  try {
    // an ancestor that is itself a repo would make this non-null; the OS tmpdir is not one
    expect(await Git.open(plain)).toBeNull();
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});

test("status: clean tree, head info and branch", async () => {
  const s = await (await git()).status();
  expect(s).toMatchObject({ repo: true, branch: "main", detached: false, upstream: null, ahead: 0, behind: 0, state: null, stash: 0, files: {} });
  expect(s.head).toMatchObject({ subject: "init", author: "Tester" });
  expect(s.head!.hash).toMatch(/^[0-9a-f]{40,64}$/);
  expect(s.oid).toBe(s.head!.hash);
  expect(s.head!.time).toBeGreaterThan(1.6e12);
});

test("status: modified, staged, untracked, renamed (with spaces), ignored", async () => {
  await writeFile(path.join(repo, "a.txt"), "one\nTWO\nthree\n");
  await writeFile(path.join(repo, "new file.txt"), "x");
  await writeFile(path.join(repo, ".gitignore"), "ignored.log\n");
  await writeFile(path.join(repo, "ignored.log"), "x");
  sh(["add", ".gitignore"]);
  sh(["mv", "old name.txt", "renamed name.txt"]);
  const s = await (await git()).status();
  expect(s.files["a.txt"]).toBe(".M");
  expect(s.files["new file.txt"]).toBe("??");
  expect(s.files["ignored.log"]).toBe("!!");
  expect(s.files[".gitignore"]).toBe("A.");
  expect(s.files["renamed name.txt"]).toBe("R."); // type-2 record, original path skipped
  expect(Object.keys(s.files).some((k) => k.includes("old name"))).toBe(false);
  sh(["reset", "-q", "--hard"]);
  sh(["clean", "-qfdx"]);
});

test("status from a subdirectory root is prefix-relative and excludes outside paths", async () => {
  await writeFile(path.join(repo, "sub", "s.txt"), "changed\n");
  await writeFile(path.join(repo, "a.txt"), "outside change\n");
  const s = await (await git(path.join(repo, "sub"))).status();
  expect(s.files).toEqual({ "s.txt": ".M" });
  sh(["checkout", "--", "."]);
});

test("status: stash count, detached HEAD, upstream ahead/behind", async () => {
  const g = await git();
  await writeFile(path.join(repo, "a.txt"), "stash me\n");
  sh(["stash", "-q"]);
  expect((await g.status()).stash).toBe(1);

  // a bare "remote" to get an upstream with ahead/behind
  const remote = path.join(dir, "remote.git");
  sh(["init", "-q", "--bare", "-b", "main", remote], dir);
  sh(["remote", "add", "origin", remote]);
  sh(["push", "-q", "-u", "origin", "main"]);
  await writeFile(path.join(repo, "sub", "ahead.txt"), "1");
  sh(["add", "."]);
  commit("ahead 1");
  let s = await g.status();
  expect(s).toMatchObject({ upstream: "origin/main", ahead: 1, behind: 0 });
  sh(["reset", "-q", "--hard", "HEAD~1"]);
  sh(["branch", "-f", "behind-marker", "origin/main"]);
  s = await g.status();
  expect(s).toMatchObject({ ahead: 0, behind: 0 });

  const head = sh(["rev-parse", "HEAD"]).trim();
  sh(["checkout", "-q", "--detach", head]);
  s = await g.status();
  expect(s).toMatchObject({ detached: true, branch: null });
  sh(["checkout", "-q", "main"]);
});

test("status reports in-progress operations (merge conflict -> UU, merging)", async () => {
  const g = await git();
  sh(["checkout", "-q", "-b", "other"]);
  await writeFile(path.join(repo, "a.txt"), "other side\n");
  sh(["commit", "-qam", "other", "--author=T <t@example.com>"]);
  sh(["checkout", "-q", "main"]);
  await writeFile(path.join(repo, "a.txt"), "main side\n");
  sh(["commit", "-qam", "main"]);
  Bun.spawnSync(["git", "merge", "other"], { cwd: repo, stdout: "ignore", stderr: "ignore" });
  const s = await g.status();
  expect(s.state).toBe("merging");
  expect(s.files["a.txt"]).toBe("UU");
  sh(["merge", "--abort"]);
  expect((await g.status()).state).toBeNull();
});

test("status reports other operation states from marker files", async () => {
  const g = await git();
  const gd = path.join(repo, ".git");
  for (const [file, state] of [["CHERRY_PICK_HEAD", "cherry-picking"], ["REVERT_HEAD", "reverting"], ["BISECT_LOG", "bisecting"]] as const) {
    await writeFile(path.join(gd, file), "x");
    expect((await g.status()).state).toBe(state);
    await rm(path.join(gd, file));
  }
  await mkdir(path.join(gd, "rebase-merge"));
  expect((await g.status()).state).toBe("rebasing");
  await rm(path.join(gd, "rebase-merge"), { recursive: true });
  expect((await g.status()).state).toBeNull();
});

test("concurrent status calls share a run and a re-run is flagged", async () => {
  const g = await git();
  const [a, b] = await Promise.all([g.status(), g.status()]);
  expect(b).toBe(a);
});

test("base() returns HEAD content or null", async () => {
  const g = await git();
  await writeFile(path.join(repo, "a.txt"), "dirty\n");
  expect(new TextDecoder().decode((await g.base("a.txt", 1 << 20))!)).toBe("main side\n"); // HEAD content, not the dirty worktree
  expect(await g.base("does-not-exist.txt", 1 << 20)).toBeNull();
  expect(await g.base("a.txt", 3)).toBeNull(); // truncated => treated as unavailable
  const sub = await git(path.join(repo, "sub"));
  expect(new TextDecoder().decode((await sub.base("s.txt", 1 << 20))!)).toBe("s\n");
  sh(["checkout", "--", "."]);
});

test("blame: committed line, uncommitted line, and failures", async () => {
  const g = await git();
  const b = (await g.blame("sub/s.txt", 1))!;
  expect(b).toMatchObject({ author: "Tester", mail: "t@example.com", summary: "init", uncommitted: false, you: true });
  expect(b.time).toBeGreaterThan(1.6e12);
  await writeFile(path.join(repo, "sub", "s.txt"), "s\nnew line\n");
  const u = (await g.blame("sub/s.txt", 2))!;
  expect(u).toMatchObject({ uncommitted: true, you: true });
  expect(await g.blame("nope.txt", 1)).toBeNull();
  expect(await g.blame("sub/s.txt", 99)).toBeNull();
  sh(["checkout", "--", "."]);
});

test("blame: someone else's commit is not 'you'", async () => {
  const g = await git();
  await writeFile(path.join(repo, "theirs.txt"), "x\n");
  sh(["add", "theirs.txt"]);
  sh(["-c", "user.name=Other", "-c", "user.email=other@example.com", "commit", "-qm", "theirs"]);
  const b = (await g.blame("theirs.txt", 1))!;
  expect(b).toMatchObject({ author: "Other", mail: "other@example.com", you: false, uncommitted: false });
});

test("watch/poke: reports status changes once, debounced, and stops", async () => {
  const g = await git();
  const seen: GitStatus[] = [];
  g.watch((s) => seen.push(s));
  g.poke(); // baseline
  await until(() => seen.length >= 1);
  const n = seen.length;
  g.poke();
  g.poke();
  await Bun.sleep(700);
  expect(seen.length).toBe(n); // identical status: no new notification

  await writeFile(path.join(repo, "watched.txt"), "x");
  g.poke();
  await until(() => seen.some((s) => s.files["watched.txt"] === "??"));
  await rm(path.join(repo, "watched.txt"));
});

test("watch: .git changes (index/HEAD) trigger a refresh, lock files and config handled", async () => {
  const g = await git();
  const seen: GitStatus[] = [];
  g.watch((s) => seen.push(s));
  await Bun.sleep(150);
  await writeFile(path.join(repo, "viaindex.txt"), "x");
  sh(["add", "viaindex.txt"]); // writes .git/index (and index.lock, which is ignored)
  await until(() => seen.some((s) => s.files["viaindex.txt"] === "A."));
  const before = seen.length;
  sh(["config", "core.abbrev", "9"]); // config change resets the cached overrides and re-polls
  await Bun.sleep(900);
  expect(seen.length).toBeGreaterThanOrEqual(before);
  sh(["reset", "-q", "--hard"]);
  sh(["clean", "-qfd"]);
});

test("filter/diff/merge drivers from config are neutralized without breaking status", async () => {
  sh(["config", "filter.x.clean", "false"]);
  sh(["config", "diff.y.textconv", "false"]);
  sh(["config", "merge.z.driver", "false"]);
  const s = await (await git()).status();
  expect(s.repo).toBe(true);
  sh(["config", "--remove-section", "filter.x"]);
  sh(["config", "--remove-section", "diff.y"]);
  sh(["config", "--remove-section", "merge.z"]);
});

test("a corrupt repo yields a status with no file entries rather than throwing", async () => {
  const g = await git();
  const gd = path.join(repo, ".git");
  await rename(path.join(gd, "HEAD"), path.join(gd, "HEAD.bak"));
  try {
    const s = await g.status();
    expect(s.repo).toBe(true);
    expect(s.files).toEqual({});
    expect(s.head).toBeNull();
  } finally {
    await rename(path.join(gd, "HEAD.bak"), path.join(gd, "HEAD"));
  }
});

test("a linked worktree does not report the main worktree's merge, and a nested repo is not an untracked file", async () => {
  const wt = path.join(dir, "wt");
  sh(["worktree", "add", "-q", "-b", "wt-branch", wt]);
  try {
    const gitDir = sh(["rev-parse", "--absolute-git-dir"]).trim();
    await writeFile(path.join(gitDir, "MERGE_HEAD"), sh(["rev-parse", "HEAD"]));
    try {
      expect((await git()).status().then((s) => s.state)).resolves.toBe("merging");
      expect((await git(wt)).status().then((s) => s.state)).resolves.toBe(null);
    } finally {
      await rm(path.join(gitDir, "MERGE_HEAD"), { force: true });
    }
    await mkdir(path.join(wt, "inner"));
    sh(["init", "-q"], path.join(wt, "inner"));
    await writeFile(path.join(wt, "inner", "x.txt"), "x\n");
    const c = await (await git(wt)).changes("head");
    expect(c.files.map((f) => f.path)).not.toContain("inner/");
  } finally {
    sh(["worktree", "remove", "--force", wt]);
  }
});

test("status: a viewed subfolder that is itself ignored is reported as rootIgnored", async () => {
  await mkdir(path.join(repo, "ignoreddir"));
  await writeFile(path.join(repo, "ignoreddir", "x.txt"), "x");
  const { readFile } = await import("node:fs/promises");
  const prior = await readFile(path.join(repo, ".gitignore"), "utf8").catch(() => null);
  await writeFile(path.join(repo, ".gitignore"), `${prior ?? ""}ignoreddir/\n`);
  try {
    const sub = await git(path.join(repo, "ignoreddir"));
    const s = await sub.status();
    expect(s.rootIgnored).toBe(true);
    expect(s.files).toEqual({});
    const top = await (await git()).status();
    expect(top.rootIgnored).toBe(false);
    expect(top.files["ignoreddir/"]).toBe("!!");
    const plain = await (await git(path.join(repo, "sub"))).status();
    expect(plain.rootIgnored).toBe(false);
  } finally {
    if (prior === null) await rm(path.join(repo, ".gitignore"), { force: true });
    else await writeFile(path.join(repo, ".gitignore"), prior);
    await rm(path.join(repo, "ignoreddir"), { recursive: true, force: true });
  }
});

test("detectBase: on main, the upstream origin/main wins over a stale local master", async () => {
  const r = path.join(dir, "onmain");
  await mkdir(r);
  sh(["init", "-q", "-b", "main"], r);
  await writeFile(path.join(r, "f.txt"), "1\n");
  sh(["add", "."], r);
  sh(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "one"], r);
  sh(["branch", "master"], r); // stale: stays on the first commit
  await writeFile(path.join(r, "f.txt"), "1\n2\n");
  sh(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qam", "two"], r);
  const remote = path.join(dir, "onmain-remote.git");
  sh(["init", "-q", "--bare", "-b", "main", remote], dir);
  sh(["remote", "add", "origin", remote], r);
  sh(["push", "-q", "-u", "origin", "main"], r); // no origin/HEAD: `remote add` + push never sets it
  expect(Bun.spawnSync(["git", "symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { cwd: r }).exitCode).not.toBe(0);
  const g = await git(r);
  const c = await g.changes("branch");
  expect(c.base?.name).toBe("origin/main");
  expect(c.base?.same).toBe(true);
  // Off main, the local branches come first again.
  sh(["checkout", "-qb", "topic"], r);
  expect((await g.changes("branch")).base?.name).toBe("main");
});
