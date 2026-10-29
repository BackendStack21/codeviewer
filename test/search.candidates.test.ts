import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/server/git.ts";
import { FileIndex } from "../src/server/index.ts";
import * as S from "../src/server/search.ts";
import { done, files, makeServer, type Fx } from "./helpers/searchsrv.ts";

const sh = (cwd: string, cmd: string[]) => {
  const r = Bun.spawnSync(["git", ...cmd], { cwd, stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr}`);
};
async function until(cond: () => Promise<boolean>, ms = 8000) {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await Bun.sleep(40);
  }
}
const sorted = (a: string[]) => [...a].sort();

let tmp = "";
let repo = "";
let plain = "";
const gits: Git[] = [];
const servers: Fx[] = [];

async function mk(dir: string, tree: Record<string, string>) {
  for (const [rel, body] of Object.entries(tree)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
}
async function srv(root: string) {
  const fx = await makeServer(async () => {}, { root });
  servers.push(fx);
  return fx;
}
async function cand(root: string) {
  const git = Git.open(root).then((g) => {
    if (g) gits.push(g);
    return g;
  });
  return new S.Candidates(root, new FileIndex(root), git);
}

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "cv-cand-")));
  repo = path.join(tmp, "repo");
  plain = path.join(tmp, "plain");
  await mkdir(repo);
  await mkdir(plain);
  sh(repo, ["init", "-q", "-b", "main"]);
  await mk(repo, {
    ".gitignore": "ignored.txt\nbuild/\n",
    "tracked.txt": "needle tracked\n",
    "src/a.ts": "needle a\n",
    "src/deep/b.ts": "needle b\n",
    "src/c.md": "needle c\n",
    "ignored.txt": "needle ignored\n",
    "build/out.js": "needle build\n",
    "node_modules/pkg/index.js": "needle dep\n",
  });
  sh(repo, ["add", ".gitignore", "tracked.txt", "src"]);
  await mk(repo, { "untracked.txt": "needle untracked\n" });
  await mk(plain, { "p.txt": "needle p\n", "sub/q.txt": "needle q\n", "node_modules/x/i.js": "needle x\n" });
});
afterAll(async () => {
  for (const g of gits) g.stop();
  for (const s of servers) await s.stop();
  await rm(tmp, { recursive: true, force: true });
});

describe("Git.listFiles (AC-11)", () => {
  test("tracked plus untracked non-ignored, ignored excluded, NUL-split exact paths", async () => {
    const g = (await Git.open(repo))!;
    gits.push(g);
    const list = await g.listFiles();
    expect(list).not.toBeNull();
    expect(sorted(list!)).toEqual(sorted([".gitignore", "tracked.txt", "src/a.ts", "src/deep/b.ts", "src/c.md", "untracked.txt"]));
  });
  test("a file whose name has a newline and quotes is returned verbatim", async () => {
    const d = path.join(tmp, "weird");
    await mkdir(d);
    sh(d, ["init", "-q", "-b", "main"]);
    const name = 'we"ird\nname.txt';
    await writeFile(path.join(d, name), "needle\n");
    const g = (await Git.open(d))!;
    gits.push(g);
    expect(await g.listFiles()).toEqual([name]);
  });
  test("paths are relative to a sub-directory root", async () => {
    const g = (await Git.open(path.join(repo, "src")))!;
    gits.push(g);
    expect(sorted((await g.listFiles())!)).toEqual(["a.ts", "c.md", "deep/b.ts"]);
  });
});

describe("parseGlobs / filterByGlobs (AC-13, AC-26)", () => {
  test("parseGlobs trims and drops empty entries", () => {
    expect(S.parseGlobs(" src/**/*.ts , ,docs/** ,")).toEqual(["src/**/*.ts", "docs/**"]);
    expect(S.parseGlobs("")).toEqual([]);
    expect(S.parseGlobs(null)).toEqual([]);
    expect(S.parseGlobs(undefined)).toEqual([]);
  });
  const all = ["a.txt", "src/a.ts", "src/deep/b.ts", "src/c.md", "docs/readme.md"];
  test("no globs keeps everything", () => {
    expect(S.filterByGlobs(all, [], [])).toEqual(all);
  });
  test("include keeps only matching paths", () => {
    expect(S.filterByGlobs(all, ["src/**/*.ts"], [])).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(S.filterByGlobs(all, ["src/**/*.ts", "docs/**"], [])).toEqual(["src/a.ts", "src/deep/b.ts", "docs/readme.md"]);
  });
  test("exclude removes matching paths and wins over include", () => {
    expect(S.filterByGlobs(all, [], ["src/**"])).toEqual(["a.txt", "docs/readme.md"]);
    expect(S.filterByGlobs(all, ["src/**"], ["**/*.md"])).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });
});

describe("containedOnly: realpath containment (AC-7, SL02 review R-04)", () => {
  test("a path reached through a symlinked parent that points outside is dropped", async () => {
    const root = path.join(tmp, "croot");
    const out = path.join(tmp, "coutside");
    await mkdir(root);
    await mkdir(out);
    await writeFile(path.join(out, "secret.txt"), "needle OUTSIDE-SECRET\n");
    await writeFile(path.join(root, "ok.txt"), "needle\n");
    await mkdir(path.join(root, "real"));
    await writeFile(path.join(root, "real", "in.txt"), "needle\n");
    await symlink(out, path.join(root, "linkdir"));
    await symlink(path.join(root, "real"), path.join(root, "inlink"));
    const kept = await S.containedOnly(root, ["ok.txt", "linkdir/secret.txt", "real/in.txt", "inlink/in.txt", "missing.txt"]);
    expect(kept).toContain("ok.txt");
    expect(kept).toContain("real/in.txt");
    expect(kept).not.toContain("linkdir/secret.txt");
    expect(kept).not.toContain("missing.txt");
  });
  test("traversal and absolute entries are dropped", async () => {
    const root = path.join(tmp, "croot");
    expect(await S.containedOnly(root, ["../coutside/secret.txt", "/etc/hosts", "ok.txt"])).toEqual(["ok.txt"]);
  });
});

describe("Candidates (AC-11, AC-12, AC-26)", () => {
  test("git repo: ls-files list, ignored file and build dir absent, untracked present", async () => {
    const c = await cand(repo);
    const l = await c.list();
    expect(l).toContain("untracked.txt");
    expect(l).toContain("src/a.ts");
    expect(l).not.toContain("ignored.txt");
    expect(l).not.toContain("build/out.js");
    expect(l).not.toContain("node_modules/pkg/index.js");
  });
  test("ignored=true includes ignored files through the index, still skipping HEAVY_DIRS", async () => {
    const c = await cand(repo);
    const l = await c.list({ ignored: true });
    expect(l).toContain("ignored.txt");
    expect(l).toContain("build/out.js");
    expect(l).toContain("untracked.txt");
    expect(l).not.toContain("node_modules/pkg/index.js");
    expect(l.some((p) => p.startsWith(".git/"))).toBe(false);
  });
  test("non-git directory falls back to FileIndex (HEAVY_DIRS skipped)", async () => {
    const c = await cand(plain);
    expect(sorted(await c.list())).toEqual(["p.txt", "sub/q.txt"]);
  });
  test("include/exclude apply on top of the list", async () => {
    const c = await cand(repo);
    expect(sorted(await c.list({ include: "src/**/*.ts" }))).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(sorted(await c.list({ include: "src/**", exclude: " **/*.md , " }))).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(await c.list({ include: " , " })).toContain("tracked.txt");
  });
  test("the git list is cached until invalidate()", async () => {
    const d = path.join(tmp, "cache");
    await mkdir(d);
    sh(d, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(d, "one.txt"), "x\n");
    const c = await cand(d);
    expect(await c.list()).toEqual(["one.txt"]);
    await writeFile(path.join(d, "two.txt"), "x\n");
    expect(await c.list()).toEqual(["one.txt"]);
    c.invalidate();
    expect(sorted(await c.list())).toEqual(["one.txt", "two.txt"]);
  });
});

describe("GET /api/search candidates (AC-11, AC-12, AC-13, AC-26)", () => {
  test("git repo: ignored file is not matched, untracked is; ignored=1 adds it", async () => {
    const fx = await srv(repo);
    const r = await fx.search({ q: "needle" });
    const paths = files(r.events).map((f) => f.path);
    expect(paths).toContain("untracked.txt");
    expect(paths).toContain("src/a.ts");
    expect(paths).not.toContain("ignored.txt");
    expect(paths).not.toContain("build/out.js");
    const r2 = await fx.search({ q: "needle", ignored: "1" });
    const p2 = files(r2.events).map((f) => f.path);
    expect(p2).toContain("ignored.txt");
    expect(p2).toContain("build/out.js");
    expect(p2).not.toContain("node_modules/pkg/index.js");
    expect(done(r2.events)!.truncated).toBe(false);
  });
  test("include and exclude params filter scanned paths", async () => {
    const fx = await srv(repo);
    const r = await fx.search({ q: "needle", include: "src/**", exclude: "**/*.md, **/deep/**" });
    expect(files(r.events).map((f) => f.path)).toEqual(["src/a.ts"]);
    const r2 = await fx.search({ q: "needle", include: " , src/**/*.ts" });
    expect(files(r2.events).map((f) => f.path).sort()).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });
  test("non-git directory searches through FileIndex", async () => {
    const fx = await srv(plain);
    const r = await fx.search({ q: "needle" });
    expect(files(r.events).map((f) => f.path).sort()).toEqual(["p.txt", "sub/q.txt"]);
  });
  test("a file created after a watcher batch appears in the next search", async () => {
    const d = path.join(tmp, "live");
    await mkdir(d);
    sh(d, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(d, "old.txt"), "needle old\n");
    const fx = await srv(d);
    expect(files((await fx.search({ q: "needle" })).events).map((f) => f.path)).toEqual(["old.txt"]);
    await Bun.sleep(300);
    await writeFile(path.join(d, "fresh.txt"), "needle fresh\n");
    await until(async () => files((await fx.search({ q: "needle" })).events).some((f) => f.path === "fresh.txt"));
  });
  test("a deleted tracked-or-untracked file disappears after a watcher batch", async () => {
    const d = path.join(tmp, "live2");
    await mkdir(d);
    sh(d, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(d, "keep.txt"), "needle keep\n");
    await writeFile(path.join(d, "gone.txt"), "needle gone\n");
    const fx = await srv(d);
    expect(files((await fx.search({ q: "needle" })).events).length).toBe(2);
    await Bun.sleep(300);
    await rm(path.join(d, "gone.txt"));
    await until(async () => !files((await fx.search({ q: "needle" })).events).some((f) => f.path === "gone.txt"));
  });
});
