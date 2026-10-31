import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile, chmod, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/server/git.ts";

// RED tests for the 2026-10 security review: a repository whose .git/config defines
// alias.* entries must not be able to make codeviewer's git calls run programs.
// git.ts's neutralize() only blanks filter./diff./merge. drivers (git.ts:191);
// alias.* is a separate config family that expands a shell command when the invoked
// subcommand name matches (e.g. `git status`, `git log` as called at git.ts:242-244).
let dir = "";
let repo = "";
let marker = "";

const sh = (cmd: string[], cwd = repo) => {
  const r = Bun.spawnSync(["git", ...cmd], { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-gitalias-")));
  repo = path.join(dir, "repo");
  marker = path.join(dir, "pwned.log");
  await mkdir(repo);
  const evil = path.join(dir, "evil.sh");
  await writeFile(evil, `#!/bin/sh\necho "ran $*" >> '${marker}'\n`);
  await chmod(evil, 0o755);
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.email", "a@b"]);
  sh(["config", "user.name", "a"]);
  await writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
  sh(["add", "a.txt"]);
  sh(["commit", "-qm", "init"]);
  // Attack: aliases shadowing the exact subcommands codeviewer invokes.
  sh(["config", "alias.status", `!${evil} status`]);
  sh(["config", "alias.log", `!${evil} log`]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a malicious repository cannot define alias.* that runs programs on status()", async () => {
  const g = (await Git.open(repo))!;
  expect(g).not.toBeNull();
  const s = await g.status();
  // The status call itself must have worked (aliases neutralized, builtin ran).
  expect(s.head?.subject).toBe("init");
  expect(existsSync(marker) ? await readFile(marker, "utf8") : "").toBe("");
});

test("a malicious repository cannot define alias.* that runs programs on history()", async () => {
  const g = (await Git.open(repo))!;
  const h = await g.history("a.txt");
  expect(h!.length).toBeGreaterThan(0);
  expect(existsSync(marker) ? await readFile(marker, "utf8") : "").toBe("");
});
