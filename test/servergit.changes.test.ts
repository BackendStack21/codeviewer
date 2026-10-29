import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git, isOid, MAX_CHANGES } from "../src/server/git.ts";

let dir = "";
let upstream = "";
let repo = "";
const open: Git[] = [];

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cmd: string[], cwd = repo) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=Tester", "-c", "user.email=t@example.com", ...cmd], { cwd, stderr: "pipe", env });
  if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};
async function git(root = repo) {
  const g = (await Git.open(root))!;
  expect(g).not.toBeNull();
  open.push(g);
  return g;
}
const byPath = (files: { path: string }[]) => Object.fromEntries(files.map((f) => [f.path, f]));

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-changes-")));
  upstream = path.join(dir, "upstream");
  await mkdir(upstream);
  sh(["init", "-q", "-b", "main"], upstream);
  await writeFile(path.join(upstream, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(upstream, "bin.dat"), new Uint8Array([0, 1, 2, 3]));
  await writeFile(path.join(upstream, "old name.txt"), "rename me, I am long enough to be detected as a rename\nline2\nline3\n");
  await mkdir(path.join(upstream, "sub"));
  await writeFile(path.join(upstream, "sub", "s.txt"), "s1\ns2\n");
  sh(["add", "."], upstream);
  sh(["commit", "-qm", "init"], upstream);
  // A clone has origin/HEAD, which is the preferred base.
  sh(["clone", "-q", upstream, "repo"], dir);
  repo = path.join(dir, "repo");
});
afterAll(async () => {
  for (const g of open) g.stop();
  await rm(dir, { recursive: true, force: true });
});

test("isOid accepts full sha1/sha256 ids only", () => {
  expect(isOid("a".repeat(40))).toBe(true);
  expect(isOid("0123456789abcdef".repeat(4))).toBe(true);
  expect(isOid("a".repeat(39))).toBe(false);
  expect(isOid("HEAD")).toBe(false);
  expect(isOid("main..HEAD")).toBe(false);
  expect(isOid("-" + "a".repeat(39))).toBe(false);
  expect(isOid("A".repeat(40))).toBe(false);
});

test("clean clone on main: base is origin/main and the scopes coincide", async () => {
  const g = await git();
  const c = await g.changes("branch");
  const head = sh(["rev-parse", "HEAD"]);
  expect(c.base).toEqual({ name: "origin/main", oid: head, mergeBase: head, same: true });
  expect(c.scope).toBe("head"); // nothing on top of the base: branch scope collapses
  expect(c.rev).toBe(head);
  expect(c.files).toEqual([]);
  expect(c.commits).toBe(0);
  expect(c.truncated).toBe(false);
});

test("feature branch: branch scope diffs the working tree against the merge-base, head scope against HEAD", async () => {
  const mainOid = sh(["rev-parse", "HEAD"]);
  sh(["checkout", "-qb", "feature"]);
  await writeFile(path.join(repo, "a.txt"), "one\nTWO\nthree\nfour\n");
  sh(["mv", "old name.txt", "new.txt"]);
  sh(["rm", "-q", "bin.dat"]);
  sh(["commit", "-qam", "feat: first"]);
  sh(["commit", "-q", "--allow-empty", "-m", "chore: empty"]);
  // Uncommitted on top: a further edit, an untracked text file (with a space), an untracked binary.
  await writeFile(path.join(repo, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
  await writeFile(path.join(repo, "new.txt"), "rename me, I am long enough to be detected as a rename\nline2\nline3\nmore\n");
  await writeFile(path.join(repo, "notes todo.md"), "a\nb\nc"); // no trailing newline: still 3 lines
  await writeFile(path.join(repo, "blob.bin"), new Uint8Array([0, 255, 0]));
  const g = await git();
  const headOid = sh(["rev-parse", "HEAD"]);

  const b = await g.changes("branch");
  expect(b.scope).toBe("branch");
  expect(b.base).toEqual({ name: "origin/main", oid: mainOid, mergeBase: mainOid, same: false });
  expect(b.rev).toBe(mainOid);
  expect(b.commits).toBe(2);
  expect(b.subjects).toEqual(["chore: empty", "feat: first"]);
  const bf = byPath(b.files);
  expect(bf["a.txt"]).toEqual({ path: "a.txt", status: "M", added: 3, removed: 1, binary: false });
  expect(bf["bin.dat"]).toEqual({ path: "bin.dat", status: "D", added: null, removed: null, binary: true });
  expect(bf["new.txt"]).toEqual({ path: "new.txt", oldPath: "old name.txt", status: "R", added: 1, removed: 0, binary: false });
  expect(bf["notes todo.md"]).toEqual({ path: "notes todo.md", status: "?", added: 3, removed: 0, binary: false });
  expect(bf["blob.bin"]).toEqual({ path: "blob.bin", status: "?", added: null, removed: null, binary: true });
  expect(Object.keys(bf).sort()).toEqual(["a.txt", "bin.dat", "blob.bin", "new.txt", "notes todo.md"]);

  const hd = await g.changes("head");
  expect(hd.scope).toBe("head");
  expect(hd.rev).toBe(headOid);
  expect(hd.base?.same).toBe(false); // the base is still reported, so the client can offer the switch
  expect(hd.commits).toBe(0);
  const hf = byPath(hd.files);
  expect(hf["a.txt"]).toMatchObject({ status: "M", added: 1, removed: 0 });
  expect(hf["new.txt"]).toMatchObject({ status: "M", added: 1, removed: 0 });
  expect(hf["bin.dat"]).toBeUndefined(); // deleted in a commit: not an uncommitted change
  expect(hf["notes todo.md"]).toMatchObject({ status: "?" });

  // base(rel, max, rev): the old side of a diff, including files that no longer exist on disk.
  const td = new TextDecoder();
  expect(td.decode((await g.base("a.txt", 1 << 20, mainOid))!)).toBe("one\ntwo\nthree\n");
  expect(td.decode((await g.base("old name.txt", 1 << 20, mainOid))!)).toStartWith("rename me");
  expect(await g.base("old name.txt", 1 << 20, headOid)).toBeNull();
  expect(await g.base("a.txt", 1 << 20, "main")).toBeNull(); // only object ids, never ref names
  expect(await g.base("a.txt", 1 << 20, "--output=/tmp/x")).toBeNull();
});

test("a viewed subfolder lists only its own files, relative to itself", async () => {
  await writeFile(path.join(repo, "sub", "s.txt"), "s1\nS2\ns3\n");
  await writeFile(path.join(repo, "sub", "u.txt"), "u\n");
  const g = await git(path.join(repo, "sub"));
  const c = await g.changes("branch");
  expect(c.files.map((f) => f.path).sort()).toEqual(["s.txt", "u.txt"]);
  expect(byPath(c.files)["s.txt"]).toMatchObject({ status: "M", added: 2, removed: 1 });
  expect(td(await g.base("s.txt", 1 << 20, c.rev!))).toBe("s1\ns2\n");
});
const td = (b: Uint8Array | null) => new TextDecoder().decode(b!);

test("detached HEAD still compares with the base; a repo without remote falls back to local main", async () => {
  const g = await git();
  sh(["checkout", "-q", "--detach"]);
  try {
    const c = await g.changes("branch");
    expect(c.base?.name).toBe("origin/main");
    expect(c.scope).toBe("branch");
  } finally {
    sh(["checkout", "-q", "feature"]);
  }

  const local = path.join(dir, "local");
  await mkdir(local);
  sh(["init", "-q", "-b", "main"], local);
  await writeFile(path.join(local, "f.txt"), "1\n");
  sh(["add", "."], local);
  sh(["commit", "-qm", "init"], local);
  const lg = await git(local);
  // On main with no upstream: nothing to compare with.
  expect((await lg.changes("branch")).base).toBeNull();
  sh(["checkout", "-qb", "topic"], local);
  await writeFile(path.join(local, "f.txt"), "1\n2\n");
  sh(["commit", "-qam", "two"], local);
  const c = await lg.changes("branch");
  expect(c.base?.name).toBe("main");
  expect(c.base?.same).toBe(false);
  expect(c.commits).toBe(1);
  expect(c.files).toEqual([{ path: "f.txt", status: "M", added: 1, removed: 0, binary: false }]);
});

test("unborn branch: no rev, untracked files only", async () => {
  const empty = path.join(dir, "empty");
  await mkdir(empty);
  sh(["init", "-q", "-b", "main"], empty);
  await writeFile(path.join(empty, "x.txt"), "x\n");
  const g = await git(empty);
  const c = await g.changes("branch");
  expect(c.rev).toBeNull();
  expect(c.base).toBeNull();
  expect(c.files).toEqual([{ path: "x.txt", status: "?", added: 1, removed: 0, binary: false }]);
});

test("merge conflicts are listed as U, including modify/delete ones", async () => {
  const c = path.join(dir, "conflict");
  await mkdir(c);
  sh(["init", "-q", "-b", "main"], c);
  await writeFile(path.join(c, "c.txt"), "base\n");
  await writeFile(path.join(c, "md.txt"), "gone on one side\n");
  sh(["add", "."], c);
  sh(["commit", "-qm", "init"], c);
  sh(["checkout", "-qb", "feat"], c);
  await writeFile(path.join(c, "c.txt"), "feat\n");
  await writeFile(path.join(c, "md.txt"), "edited\n");
  sh(["commit", "-qam", "feat"], c);
  sh(["checkout", "-q", "main"], c);
  await writeFile(path.join(c, "c.txt"), "main\n");
  sh(["rm", "-q", "md.txt"], c);
  sh(["commit", "-qam", "main"], c);
  expect(() => sh(["merge", "feat"], c)).toThrow();
  const g = await git(c);
  const out = byPath((await g.changes("head")).files);
  expect(out["c.txt"]).toMatchObject({ status: "U" });
  expect(out["md.txt"]).toMatchObject({ status: "U" });
});

test("a file removed from the index but present on disk is one modified entry", async () => {
  const d = path.join(dir, "cached");
  await mkdir(d);
  sh(["init", "-q", "-b", "main"], d);
  await writeFile(path.join(d, "f.txt"), "1\n");
  sh(["add", "."], d);
  sh(["commit", "-qm", "init"], d);
  sh(["rm", "-q", "--cached", "f.txt"], d);
  const g = await git(d);
  const c = await g.changes("head");
  expect(c.files).toEqual([{ path: "f.txt", status: "M", added: null, removed: null, binary: false }]);
});

test("an orphan branch with staged files lists them as added against the empty tree", async () => {
  const d = path.join(dir, "orphan");
  await mkdir(d);
  sh(["init", "-q", "-b", "main"], d);
  await writeFile(path.join(d, "s.txt"), "1\n2\n");
  sh(["add", "."], d);
  const g = await git(d);
  const c = await g.changes("branch");
  expect(c.rev).toBeNull();
  expect(c.files).toEqual([{ path: "s.txt", status: "A", added: 2, removed: 0, binary: false }]);
});

test("over the cap, kept entries still carry their counts and truncation is reported", async () => {
  const d = path.join(dir, "manytracked");
  await mkdir(d);
  sh(["init", "-q", "-b", "main"], d);
  const n = MAX_CHANGES + 3;
  await Promise.all(Array.from({ length: n }, (_, i) => writeFile(path.join(d, `t${String(i).padStart(4, "0")}.txt`), "a\n")));
  sh(["add", "."], d);
  sh(["commit", "-qm", "init"], d);
  await Promise.all(Array.from({ length: n }, (_, i) => writeFile(path.join(d, `t${String(i).padStart(4, "0")}.txt`), "a\nb\n")));
  const g = await git(d);
  const c = await g.changes("head");
  expect(c.files.length).toBe(MAX_CHANGES);
  expect(c.truncated).toBe(true);
  expect(c.files.every((f) => f.added === 1 && f.removed === 0)).toBe(true);
  await rm(d, { recursive: true, force: true });
});

test("hostile configs: order file, mailmap and relative paths cannot hang or blank the list", async () => {
  const d = path.join(dir, "hostile");
  await mkdir(path.join(d, "sub"), { recursive: true });
  sh(["init", "-q", "-b", "main"], d);
  await writeFile(path.join(d, "sub", "a.txt"), "1\n");
  sh(["add", "."], d);
  sh(["commit", "-qm", "init"], d);
  sh(["checkout", "-qb", "topic"], d);
  await writeFile(path.join(d, "sub", "a.txt"), "1\n2\n");
  sh(["commit", "-qam", "work"], d);
  sh(["config", "diff.orderFile", "/dev/zero"], d);
  sh(["config", "mailmap.file", "/dev/zero"], d);
  sh(["config", "diff.relative", "true"], d);
  sh(["config", "core.bigFileThreshold", "1"], d);
  const g = await git(path.join(d, "sub"));
  const t0 = performance.now();
  const c = await Promise.race([g.changes("branch"), Bun.sleep(8000).then(() => null)]);
  expect(performance.now() - t0).toBeLessThan(8000);
  expect(c?.files).toEqual([{ path: "a.txt", status: "M", added: 1, removed: 0, binary: false }]);
  expect(c?.subjects).toEqual(["work"]);
  expect(c?.commits).toBe(1);
});

test("the list is capped and reports truncation; untracked symlinks are not read", async () => {
  const many = path.join(dir, "many");
  await mkdir(many);
  sh(["init", "-q", "-b", "main"], many);
  await writeFile(path.join(many, "keep.txt"), "k\n");
  sh(["add", "."], many);
  sh(["commit", "-qm", "init"], many);
  await Promise.all(Array.from({ length: MAX_CHANGES + 5 }, (_, i) => writeFile(path.join(many, `u${String(i).padStart(4, "0")}.txt`), "u\n")));
  const g = await git(many);
  const c = await g.changes("head");
  expect(c.files.length).toBe(MAX_CHANGES);
  expect(c.truncated).toBe(true);
  expect((await (await git(many)).changes("head")).files.map((f) => f.path)).toContain("u0999.txt");
  // Only the first 200 untracked files are counted.
  expect(c.files[0]!.added).toBe(1);
  expect(c.files[c.files.length - 1]!.added).toBeNull();
  await rm(many, { recursive: true, force: true });

  const links = path.join(dir, "links");
  await mkdir(links);
  sh(["init", "-q", "-b", "main"], links);
  await writeFile(path.join(dir, "outside.txt"), "secret\nsecret\n");
  await rename(path.join(dir, "outside.txt"), path.join(dir, "outside2.txt"));
  const { symlink } = await import("node:fs/promises");
  await symlink(path.join(dir, "outside2.txt"), path.join(links, "escape"));
  const lg = await git(links);
  const lc = await lg.changes("head");
  expect(lc.files).toEqual([{ path: "escape", status: "?", added: null, removed: null, binary: false }]);
});
