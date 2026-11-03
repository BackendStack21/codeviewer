import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/server/git.ts";

// A partial clone fetches missing objects from its promisor remote on demand, and the remote's
// config names a program (remote.origin.uploadpack). Reading such a repository must never run it.
let dir = "";
let victim = "";
let marker = "";
let oldOid = "";

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(["git", ...cmd], { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-lazy-")));
  const src = path.join(dir, "src");
  victim = path.join(dir, "victim");
  marker = path.join(dir, "pwned");
  await mkdir(src);
  sh(["init", "-q", "-b", "main"], src);
  sh(["config", "uploadpack.allowFilter", "true"], src);
  sh(["config", "user.email", "a@b"], src);
  sh(["config", "user.name", "a"], src);
  await writeFile(path.join(src, "a.txt"), "one\n");
  sh(["add", "a.txt"], src);
  sh(["commit", "-qm", "one"], src);
  oldOid = sh(["rev-parse", "HEAD"], src).trim();
  await writeFile(path.join(src, "a.txt"), "two\n");
  sh(["commit", "-qam", "two"], src);
  // Blobless clone: only HEAD's blobs are present after checkout; older ones are fetched lazily.
  sh(["clone", "-q", "--no-local", "--filter=blob:none", `file://${src}`, victim], dir);
  sh(["config", "remote.origin.uploadpack", `touch '${marker}'; false`], victim);
  sh(["config", "protocol.file.allow", "always"], victim);
  sh(["config", "protocol.allow", "always"], victim);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a partial clone's promisor remote is never contacted (no lazy fetch runs its programs)", async () => {
  const g = (await Git.open(victim))!;
  expect(g).not.toBeNull();
  // The old blob is missing locally: reading it must fail instead of fetching.
  expect(await g.base("a.txt", 1 << 20, oldOid)).toBeNull();
  await g.history("a.txt");
  await g.blame("a.txt", 1);
  await g.changes("head");
  g.stop();
  expect(existsSync(marker)).toBe(false);
});

test("a viewed folder whose name starts with '..' is still inside the repository", async () => {
  const sub = path.join(victim, "..odd");
  await mkdir(sub);
  await writeFile(path.join(sub, "f.txt"), "x\n");
  const g = await Git.open(sub);
  expect(g).not.toBeNull();
  g?.stop();
});

test("a hostile blame.ignoreRevsFile neither breaks nor hangs blame", async () => {
  // The full repository: blame in the blobless clone would need a parent blob it never fetches.
  const src = path.join(dir, "src");
  for (const file of [path.join(dir, "missing"), "/dev/zero"]) {
    Bun.spawnSync(["git", "config", "blame.ignoreRevsFile", file], { cwd: src });
    const g = (await Git.open(src))!;
    const t0 = performance.now();
    const b = await g.blame("a.txt", 1);
    g.stop();
    expect(b?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(performance.now() - t0).toBeLessThan(5000);
  }
  Bun.spawnSync(["git", "config", "--unset", "blame.ignoreRevsFile"], { cwd: src });
});

test("git calls fail cleanly (no throw) once the viewed folder is deleted", async () => {
  const gone = path.join(dir, "gone");
  await mkdir(gone);
  sh(["init", "-q"], gone);
  const g = (await Git.open(gone))!;
  await rm(gone, { recursive: true, force: true });
  // Bun.spawn throws on a missing cwd; from the status refresh timer that exited the server.
  const s = await g.status();
  expect(s.repo).toBe(true);
  expect(await g.blame("f", 1)).toBeNull();
  g.stop();
});
