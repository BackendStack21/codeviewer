import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/server/git.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=Tester", "-c", "user.email=t@example.com", ...cmd], { cwd, stderr: "pipe", env });
  if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr}`);
};

let dir = "";
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-hbom-")));
  sh(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, "seed.txt"), "seed\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  await writeFile(path.join(dir, "two.txt"), "\uFEFF\uFEFFa\n");
  await writeFile(path.join(dir, "one.txt"), "\uFEFFa\n");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("a file starting with two BOMs counts the second (scanHidden's offset-0 rule), one BOM counts none", async () => {
  const git = (await Git.open(dir))!;
  const files = (await git.changes("head")).files as { path: string; hidden?: number }[];
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  expect(by["two.txt"]?.hidden).toBe(1);
  expect("hidden" in by["one.txt"]!).toBe(false);
});
