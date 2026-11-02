// The release workflow runs scripts/release-notes.ts against a real repository.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cli } from "../scripts/release-notes.ts";
import { RELEASE_FOOTER } from "../src/server/update.ts";

const SCRIPT = path.resolve(import.meta.dir, "../scripts/release-notes.ts");
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
let dir = "";
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.test", ...args], { cwd: dir, env, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
const run = (...args: string[]) => {
  const r = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-relnotes-")));
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "Release 1.0.0\n\nFirst summary\nwrapped over two lines.\n\nCo-Authored-By: A <a@example.test>");
  git("tag", "v1.0.0");
  git("commit", "-q", "--allow-empty", "-m", "Release 1.1.0\n\nSecond summary.\n\nCo-Authored-By: A <a@example.test>");
  git("tag", "v1.1.0");
  git("commit", "-q", "--allow-empty", "-m", "Release 1.2.0\n\nCo-Authored-By: A <a@example.test>");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("release-notes CLI (real process)", () => {
  test("reads HEAD by default: empty body gives the verify line and a warning", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toBe(RELEASE_FOOTER + "\n");
    expect(r.err).toContain("::warning::");
  });

  test("an older ref is read when given", () => {
    const r = run("v1.1.0");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`Second summary.\n\n${RELEASE_FOOTER}\n`);
    expect(r.out).not.toContain("Release 1.1.0");
    expect(r.out).not.toContain("Co-Authored-By");
    expect(r.err).toBe("");
    expect(run("v1.0.0").out).toBe(`First summary wrapped over two lines.\n\n${RELEASE_FOOTER}\n`);
  });

  test("HEAD default with a summary paragraph", () => {
    git("commit", "-q", "--allow-empty", "-m", "Release 1.3.0\n\nThird summary\nwrapped.\n\nCo-Authored-By: A <a@example.test>");
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toBe(`Third summary wrapped.\n\n${RELEASE_FOOTER}\n`);
    expect(r.err).toBe("");
  });

  test("a missing ref fails and prints no notes", () => {
    const r = run("v9.9.9");
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("release-notes:");
  });
});

describe("cli()", () => {
  test("HEAD default content, older ref, empty body warning, missing ref", () => {
    const old = cli("v1.1.0", dir);
    expect(old).toEqual({ code: 0, out: `Second summary.\n\n${RELEASE_FOOTER}\n`, err: "" });
    const head = cli("HEAD~1", dir);
    expect(head.out).toBe(RELEASE_FOOTER + "\n");
    expect(head.err).toStartWith("::warning::");
    const bad = cli("v9.9.9", dir);
    expect(bad.code).toBe(1);
    expect(bad.out).toBe("");
    expect(bad.err).toStartWith("release-notes: git log failed for v9.9.9");
  });
});
