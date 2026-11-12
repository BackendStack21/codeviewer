import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, utimes, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git, HIDDEN_SCAN_BUDGET } from "../src/server/git.ts";
import { startServer } from "../src/server/http.ts";

// Captured at load: other test files may swap globalThis.fetch for mocks.
const fetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch;
const token = "H".repeat(43);

const ZW = "​";
const MIB = 1024 * 1024;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=Tester", "-c", "user.email=t@example.com", ...cmd], { cwd, stderr: "pipe", env });
  if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr}`);
};
const byPath = (files: { path: string }[]) => Object.fromEntries(files.map((f) => [f.path, f])) as Record<string, { path: string; status: string; hidden?: number }>;
/** `lead` followed by "a" up to exactly `bytes` bytes (lead must be ASCII-free of length concerns: counted in UTF-8 bytes). */
const sized = (lead: string, bytes: number) => lead + "a".repeat(bytes - Buffer.byteLength(lead));

let dir = "";
let cfg = "";
let big = "";
let git!: Git;
let bigGit!: Git;
let app: ReturnType<typeof startServer>;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["XDG_CONFIG_HOME", "CODEVIEWER_NO_UPDATE_CHECK"]) saved[k] = process.env[k];
  cfg = await realpath(await mkdtemp(path.join(tmpdir(), "cv-hcfg-")));
  process.env.XDG_CONFIG_HOME = cfg;
  process.env.CODEVIEWER_NO_UPDATE_CHECK = "1";
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-hidden-")));
  sh(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, "a.txt"), "hello\n");
  await writeFile(path.join(dir, "clean.txt"), "one\n");
  await writeFile(path.join(dir, "gone.txt"), `gone${ZW}\n`);
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  // Tracked: a.txt gains one hidden character, clean.txt changes without any, gone.txt is deleted.
  await writeFile(path.join(dir, "a.txt"), `he${ZW}llo\n`);
  await writeFile(path.join(dir, "clean.txt"), "one\ntwo\n");
  await unlink(path.join(dir, "gone.txt"));
  // Untracked.
  await writeFile(path.join(dir, "rules.md"), "\u{E0041}\u{E0042}\u{E0043}\n");
  await writeFile(path.join(dir, "many.txt"), ZW.repeat(300));
  await writeFile(path.join(dir, "bom.txt"), "﻿hello\n");
  await writeFile(path.join(dir, "plain.txt"), "plain\n");
  const bin = new Uint8Array(64);
  bin.set([0, 0xe2, 0x80, 0x8b, 0xe2, 0x80, 0x8b], 0);
  await writeFile(path.join(dir, "bin.dat"), bin);
  await writeFile(path.join(dir, "target.txt"), `t${ZW}\n`);
  await symlink("target.txt", path.join(dir, "link.txt"));
  await writeFile(path.join(dir, "toobig.txt"), sized(ZW, MIB + 1));
  await writeFile(path.join(dir, "exact.txt"), sized(ZW, MIB));
  // Not `ff fe` first: that is a UTF-16 BOM, and the file is then read as UTF-16 (as the viewer does).
  await writeFile(path.join(dir, "badutf8.txt"), Buffer.concat([Buffer.from([0xc3, 0xff, 0xfe]), Buffer.from(`x${ZW}y\n`)]));
  git = (await Git.open(dir))!;
  app = startServer({ root: dir, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {} });
});
afterAll(async () => {
  git.stop();
  bigGit?.stop();
  app.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
  await rm(cfg, { recursive: true, force: true });
  if (big) await rm(big, { recursive: true, force: true });
});

test("a tracked file rewritten with a zero-width space reports hidden: 1; a clean modified file has no key", async () => {
  const f = byPath((await git.changes("head")).files);
  expect(f["a.txt"]).toMatchObject({ status: "M", hidden: 1 });
  expect(f["clean.txt"]).toBeDefined();
  expect("hidden" in f["clean.txt"]!).toBe(false);
});

test("untracked files report the full count, not capped at 200", async () => {
  const f = byPath((await git.changes("head")).files);
  expect(f["rules.md"]).toMatchObject({ status: "?", hidden: 3 });
  expect(f["many.txt"]).toMatchObject({ status: "?", hidden: 300 });
});

test("no hidden for clean, deleted, binary, linked, BOM-only and oversized files", async () => {
  const f = byPath((await git.changes("head")).files);
  for (const p of ["plain.txt", "gone.txt", "bin.dat", "link.txt", "bom.txt", "toobig.txt"]) {
    expect(f[p]).toBeDefined();
    expect("hidden" in f[p]!).toBe(false);
  }
  expect(f["gone.txt"]!.status).toBe("D");
});

test("a file of exactly 1 MiB is scanned; invalid UTF-8 does not throw and the rest is counted", async () => {
  const f = byPath((await git.changes("head")).files);
  expect(f["exact.txt"]!.hidden).toBe(1);
  expect(f["badutf8.txt"]!.hidden).toBe(1);
});

test("an unchanged file is not read again; a changed one is rescanned; stale cache entries are dropped", async () => {
  await git.changes("head");
  const before = git.hiddenReads;
  expect(before).toBeGreaterThan(0);
  expect(git.hiddenCacheSize()).toBeGreaterThan(0);
  const again = byPath((await git.changes("head")).files);
  expect(git.hiddenReads).toBe(before);
  expect(again["a.txt"]!.hidden).toBe(1);

  await writeFile(path.join(dir, "a.txt"), `he${ZW}${ZW}llo\n`);
  const changed = byPath((await git.changes("head")).files);
  expect(changed["a.txt"]!.hidden).toBe(2);
  expect(git.hiddenReads).toBeGreaterThan(before);

  // Same size, new mtime: rescanned too.
  const mid = git.hiddenReads;
  await writeFile(path.join(dir, "a.txt"), `he${ZW}${ZW}llo\n`);
  await utimes(path.join(dir, "a.txt"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  await git.changes("head");
  expect(git.hiddenReads).toBeGreaterThan(mid);

  // A listed file that disappears leaves the cache.
  await writeFile(path.join(dir, "temp.txt"), `x${ZW}\n`);
  await git.changes("head");
  const withTemp = git.hiddenCacheSize();
  await unlink(path.join(dir, "temp.txt"));
  const after = (await git.changes("head")).files;
  expect(git.hiddenCacheSize()).toBeLessThan(withTemp);
  expect(git.hiddenCacheSize()).toBeLessThanOrEqual(after.length);
});

test("at most 32 MiB of content is scanned per changes() call", async () => {
  expect(HIDDEN_SCAN_BUDGET).toBe(32 * MIB);
  big = await realpath(await mkdtemp(path.join(tmpdir(), "cv-hbig-")));
  sh(big, "init", "-q", "-b", "main");
  await writeFile(path.join(big, "seed.txt"), "seed\n");
  sh(big, "add", ".");
  sh(big, "commit", "-qm", "init");
  const body = sized(ZW, MIB);
  for (let i = 0; i < 40; i++) await writeFile(path.join(big, `f${String(i).padStart(2, "0")}.txt`), body);
  bigGit = (await Git.open(big))!;
  const f = byPath((await bigGit.changes("head")).files);
  for (let i = 0; i < 40; i++) {
    const e = f[`f${String(i).padStart(2, "0")}.txt`]!;
    expect(e).toBeDefined();
    if (i < 32) expect(e.hidden).toBe(1);
    else expect("hidden" in e).toBe(false);
  }
}, 60000);

test("GET /api/git/changes carries hidden; clean entries have no key; auth is required", async () => {
  const b = app.url.split("/#")[0]!;
  const r = await fetch(`${b}/api/git/changes?scope=head`, { headers: { "x-cv-token": token } });
  expect(r.status).toBe(200);
  const c = (await r.json()) as { files: Array<{ path: string; hidden?: number }> };
  const f = byPath(c.files);
  expect(f["rules.md"]!.hidden).toBe(3);
  expect(f["a.txt"]!.hidden).toBeGreaterThan(0);
  expect("hidden" in f["plain.txt"]!).toBe(false);
  expect("hidden" in f["clean.txt"]!).toBe(false);
  expect((await fetch(`${b}/api/git/changes`)).status).toBe(401);
});
