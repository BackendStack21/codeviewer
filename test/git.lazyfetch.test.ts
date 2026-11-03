import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

describe("round 15, second pass: configs that reach past the overrides", () => {
  const evil = () => path.join(dir, "evil2.sh");
  const marker2 = () => path.join(dir, "pwned2");
  beforeAll(async () => {
    await writeFile(evil(), `#!/bin/sh\ntouch '${marker2()}'\ncat\n`);
    Bun.spawnSync(["chmod", "+x", evil()]);
  });

  test("a submodule's own filter never runs (git does not look inside submodules)", async () => {
    const sub = path.join(dir, "subsrc");
    const top = path.join(dir, "withsub");
    await mkdir(sub);
    sh(["init", "-q"], sub);
    await writeFile(path.join(sub, "s.txt"), "x\n");
    sh(["add", "."], sub);
    sh(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "s"], sub);
    await mkdir(top);
    sh(["init", "-q"], top);
    sh(["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sm"], top);
    sh(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "i"], top);
    sh(["config", "-f", path.join(top, ".git", "modules", "sm", "config"), "filter.evil.clean", evil()], top);
    await mkdir(path.join(top, ".git", "modules", "sm", "info"), { recursive: true });
    await writeFile(path.join(top, ".git", "modules", "sm", "info", "attributes"), "* filter=evil\n");
    await writeFile(path.join(top, "sm", "s.txt"), "z\n");
    const g = (await Git.open(top))!;
    await g.changes("head");
    await g.status();
    g.stop();
    expect(existsSync(marker2())).toBe(false);
  });

  test("a driver added to an included file after the first call is still blanked", async () => {
    const r = path.join(dir, "inc");
    await mkdir(r);
    sh(["init", "-q"], r);
    await writeFile(path.join(r, "f.txt"), "hello\n");
    await writeFile(path.join(r, "inc.cfg"), "");
    sh(["add", "."], r);
    sh(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "i"], r);
    sh(["config", "include.path", "../inc.cfg"], r);
    await writeFile(path.join(r, ".git", "info", "attributes"), "f.txt filter=late\n");
    const g = (await Git.open(r))!;
    await g.changes("head");
    await writeFile(path.join(r, "inc.cfg"), `[filter "late"]\n\tclean = ${evil()}\n`);
    await writeFile(path.join(r, "f.txt"), "hellp\n");
    await g.changes("head");
    g.stop();
    expect(existsSync(marker2())).toBe(false);
  });

  test("history and blame read UTF-8 whatever i18n.logOutputEncoding says; log.showRoot=false keeps the root", async () => {
    const r = path.join(dir, "enc");
    await mkdir(r);
    sh(["init", "-q"], r);
    await writeFile(path.join(r, "f"), "1\n");
    sh(["add", "f"], r);
    sh(["-c", "user.email=a@b", "-c", "user.name=Zoë", "commit", "-qm", "café"], r);
    await writeFile(path.join(r, "f"), "2\n");
    sh(["-c", "user.email=a@b", "-c", "user.name=Zoë", "commit", "-qam", "two"], r);
    sh(["config", "i18n.logOutputEncoding", "UTF-16"], r);
    sh(["config", "log.showRoot", "false"], r);
    const g = (await Git.open(r))!;
    const h = (await g.history("f"))!;
    expect(h.map((e) => e.subject)).toEqual(["two", "café"]);
    expect(h[1]!.status).toBe("A");
    expect((await g.blame("f", 1))?.author).toBe("Zoë");
    expect((await g.status()).head?.author).toBe("Zoë");
    g.stop();
  });
});
