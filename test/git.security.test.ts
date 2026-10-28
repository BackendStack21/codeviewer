import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile, chmod, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/server/git.ts";

// A repository whose .git/config and .gitattributes try to make git run programs.
// None of them may run while codeviewer reads status, blobs, logs or blame.
let dir = "";
let repo = "";
let marker = "";

const sh = (cmd: string[], cwd = repo) => {
  const r = Bun.spawnSync(["git", ...cmd], { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-gitsec-")));
  repo = path.join(dir, "repo");
  marker = path.join(dir, "pwned.log");
  await mkdir(repo);
  const evil = path.join(dir, "evil.sh");
  await writeFile(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\n`);
  await chmod(evil, 0o755);
  sh(["init", "-q", "-b", "main"]);
  sh(["config", "user.email", "a@b"]);
  sh(["config", "user.name", "a"]);
  await writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
  sh(["add", "a.txt"]);
  sh(["commit", "-qm", "init"]);
  // Make HEAD a commit carrying a (fake) signature so signature verification would call gpg.
  const tree = sh(["rev-parse", "HEAD^{tree}"]).trim();
  const parent = sh(["rev-parse", "HEAD"]).trim();
  const body = `tree ${tree}\nparent ${parent}\nauthor a <a@b> 1700000000 +0000\ncommitter a <a@b> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  const p = Bun.spawnSync(["git", "hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, stdin: new TextEncoder().encode(body) });
  sh(["update-ref", "HEAD", p.stdout.toString().trim()]);
  // Attack surface: attributes in tree and in $GIT_DIR/info, drivers + gpg + fsmonitor in config.
  await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=pwn diff=pwn merge=pwn\n");
  await mkdir(path.join(repo, ".git", "info"), { recursive: true });
  await writeFile(path.join(repo, ".git", "info", "attributes"), "* filter=pwn2 diff=pwn2\n");
  for (const [k, v] of [
    ["filter.pwn.clean", evil], ["filter.pwn.smudge", evil], ["filter.pwn.process", evil], ["filter.pwn.required", "true"],
    ["filter.pwn2.clean", evil], ["diff.pwn.textconv", evil], ["diff.pwn2.textconv", evil], ["diff.pwn.command", evil],
    ["merge.pwn.driver", evil], ["log.showSignature", "true"], ["gpg.program", evil], ["core.fsmonitor", evil],
  ]) sh(["config", k!, v!]);
  // Dirty the file so status must compare content (which would run the clean filter).
  await writeFile(path.join(repo, "a.txt"), "one\nTWO\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a malicious repository cannot make codeviewer's git calls run programs", async () => {
  const g = (await Git.open(repo))!;
  expect(g).not.toBeNull();
  const s = await g.status();
  expect(s.files["a.txt"]).toBe(".M");
  expect(s.head?.subject).toBe("signed");
  await g.base("a.txt", 1 << 20);
  await g.blame("a.txt", 2);
  expect(existsSync(marker) ? await readFile(marker, "utf8") : "").toBe("");
});
