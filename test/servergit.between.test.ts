import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/server/git.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=Tester", "-c", "user.email=t@example.com", ...cmd], { cwd, stderr: "pipe", stdout: "pipe", env });
  if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

let dir = "";
let r1 = "";
let r2 = "";
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-between-")));
  sh(dir, "init", "-q", "-b", "main");
  await mkdir(path.join(dir, "sub"));
  await writeFile(path.join(dir, "keep.txt"), "same\n");
  await writeFile(path.join(dir, "edit me.txt"), "v0\n");
  await writeFile(path.join(dir, "gone.txt"), "bye\n");
  await writeFile(path.join(dir, "sub", "in.txt"), "v0\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "one");
  r1 = sh(dir, "rev-parse", "HEAD");
  await writeFile(path.join(dir, "edit me.txt"), "v1\n");
  await writeFile(path.join(dir, "sub", "in.txt"), "v1\n");
  await writeFile(path.join(dir, "new.txt"), "hi\n");
  sh(dir, "rm", "-q", "gone.txt");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "two");
  r2 = sh(dir, "rev-parse", "HEAD");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("between() lists the paths that differ between two commits, root-relative", async () => {
  const git = (await Git.open(dir))!;
  expect((await git.between(r1, r2))!.paths.sort()).toEqual(["edit me.txt", "gone.txt", "new.txt", "sub/in.txt"]);
  expect(await git.between(r1, r1)).toEqual({ paths: [], truncated: false });
  // No commit on the old side (a checkpoint taken before the first commit): everything is new.
  expect((await git.between(null, r1))!.paths.sort()).toEqual(["edit me.txt", "gone.txt", "keep.txt", "sub/in.txt"]);
});

test("between() in a viewed subfolder lists only what is under it, and refuses anything but object ids", async () => {
  const git = (await Git.open(path.join(dir, "sub")))!;
  expect((await git.between(r1, r2))!.paths).toEqual(["in.txt"]);
  expect(await git.between("HEAD~1", r2)).toBeNull();
  expect(await git.between(r1, "--output=/tmp/x")).toBeNull();
  expect(await git.between(r1, "f".repeat(40))).toBeNull(); // no such commit
});
