import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/server/git.ts";

// One repository that names a program in every config key and hook git might consult, with files in
// every state (modified, stat-only dirty, untracked, renamed, binary, conflicted-free). Every Git
// method runs against it; none may run a program, and none may write anything under .git.
// A key or hook added to git later that is not neutralised shows up as the marker file.

let dir = "";
let repo = "";
let marker = "";
let evil = "";

const sh = (args: string[], cwd = repo) => {
  const r = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@b", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@b" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};

/** Every file under .git with its size and mtime: any write by codeviewer changes this. */
async function snapshot(root: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const s = await stat(p);
        out.push(`${path.relative(root, p)} ${s.size} ${s.mtimeMs}`);
      }
    }
  };
  await walk(root);
  return out.sort().join("\n");
}

const HOOKS = [
  "post-index-change", "pre-commit", "post-checkout", "post-merge", "pre-auto-gc", "post-rewrite", "reference-transaction",
  "fsmonitor-watchman", "pre-push", "post-commit", "push-to-checkout", "sendemail-validate", "post-update", "update",
];

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-hostile-")));
  repo = path.join(dir, "repo");
  marker = path.join(dir, "PWNED");
  evil = path.join(dir, "evil.sh");
  await writeFile(evil, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat 2>/dev/null\nexit 0\n`);
  await chmod(evil, 0o755);
  await mkdir(repo);
  sh(["init", "-q", "-b", "main"]);
  await writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
  await writeFile(path.join(repo, "same.txt"), "unchanged\n");
  await writeFile(path.join(repo, "bin.dat"), new Uint8Array([0, 1, 2, 3, 0, 9]));
  await writeFile(path.join(repo, "old.md"), "# title\n\nbody text that is long enough to be detected as a rename\n");
  sh(["add", "."]);
  sh(["commit", "-qm", "init"]);
  sh(["branch", "feature"]);
  sh(["checkout", "-q", "feature"]);
  await writeFile(path.join(repo, "a.txt"), "one\nTWO\n");
  sh(["commit", "-qam", "on feature"]);

  // Working tree states (made before the hostile config, which would trip these setup commands): a real edit, an untracked file, a rename, a binary edit, and files whose
  // stat info changed but content did not (what an extracted tarball looks like: git wants to
  // refresh the index for these, which writes it and runs post-index-change).
  await writeFile(path.join(repo, "a.txt"), "one\nTWO\nthree\n");
  await writeFile(path.join(repo, "untracked.txt"), "new\n");
  sh(["-c", "core.hooksPath=/dev/null", "mv", "old.md", "new.md"]);
  await writeFile(path.join(repo, "bin.dat"), new Uint8Array([0, 1, 2, 3, 0, 9, 9]));

  // Every hook, in .git/hooks and in a tracked folder named by core.hooksPath.
  await mkdir(path.join(repo, ".git", "hooks"), { recursive: true });
  await mkdir(path.join(repo, "hooks"));
  for (const h of HOOKS) {
    for (const d of [path.join(repo, ".git", "hooks"), path.join(repo, "hooks")]) {
      await writeFile(path.join(d, h), `#!/bin/sh\n'${evil}' hook ${h}\n`);
      await chmod(path.join(d, h), 0o755);
    }
  }
  // Every config key known to name a program (or a file read in full).
  const keys: [string, string][] = [
    ["core.hooksPath", path.join(repo, "hooks")], ["core.fsmonitor", evil], ["core.sshCommand", evil], ["core.askPass", evil],
    ["core.editor", evil], ["core.pager", evil], ["sequence.editor", evil], ["gpg.program", evil], ["gpg.ssh.program", evil],
    ["gpg.x509.program", evil], ["credential.helper", `!${evil}`], ["interactive.diffFilter", evil], ["diff.external", evil],
    ["diff.evil.textconv", evil], ["diff.evil.command", evil], ["diff.evil.cachetextconv", "true"], ["filter.evil.clean", evil],
    ["filter.evil.smudge", evil], ["filter.evil.process", evil], ["filter.evil.required", "true"], ["merge.evil.driver", evil],
    ["core.alternateRefsCommand", evil], ["uploadpack.packObjectsHook", evil], ["remote.origin.url", `ext::${evil}`],
    ["remote.origin.uploadpack", evil], ["protocol.allow", "always"], ["protocol.ext.allow", "always"], ["log.showSignature", "true"],
    ["status.showUntrackedFiles", "all"], ["diff.renames", "copies"], ["diff.renameLimit", "0"], ["core.untrackedCache", "true"],
    ["core.splitIndex", "true"], ["gc.auto", "1"], ["maintenance.auto", "true"], ["fetch.writeCommitGraph", "true"],
    ["core.commitGraph", "true"], ["feature.manyFiles", "true"], ["index.threads", "4"], ["blame.ignoreRevsFile", "/dev/zero"],
    ["mailmap.file", "/dev/zero"], ["diff.orderFile", "/dev/zero"], ["core.excludesFile", path.join(repo, "hooks", "pre-commit")],
    ["i18n.logOutputEncoding", "UTF-16"], ["core.preloadIndex", "true"], ["pager.status", evil], ["pager.diff", evil], ["pager.log", evil],
  ];
  for (const [k, v] of keys) sh(["config", k, v]);
  // Attributes from every source git reads, binding every path to the hostile drivers.
  await writeFile(path.join(repo, ".gitattributes"), "* filter=evil diff=evil merge=evil\n");
  await mkdir(path.join(repo, ".git", "info"), { recursive: true });
  await writeFile(path.join(repo, ".git", "info", "attributes"), "* filter=evil diff=evil merge=evil\n");

  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(repo, "same.txt"), later, later);
  await rm(marker, { force: true });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("no git call runs a program, and nothing under .git is written", async () => {
  const before = await snapshot(path.join(repo, ".git"));
  const g = (await Git.open(repo))!;
  expect(g).not.toBeNull();
  await g.status();
  const head = await g.changes("head");
  const branch = await g.changes("branch");
  await g.listFiles();
  await g.base("a.txt", 1 << 20);
  await g.blame("a.txt", 2);
  await g.history("a.txt");
  await g.history("new.md");
  g.stop();
  await Bun.sleep(200); // anything spawned in the background would have written by now
  expect(existsSync(marker) ? await Bun.file(marker).text() : "").toBe("");
  expect(await snapshot(path.join(repo, ".git"))).toBe(before);

  // And the answers are still right: real edits listed, the stat-only file not.
  const paths = (c: typeof head) => c.files.map((f) => `${f.status} ${f.path}`).sort();
  expect(paths(head)).toContain("M a.txt");
  expect(paths(head)).toContain("M bin.dat");
  expect(paths(head)).toContain("? untracked.txt");
  expect(paths(head).some((p) => p.endsWith(" new.md"))).toBe(true);
  expect(paths(branch)).toContain("M a.txt");
  expect(paths(head).some((p) => p.endsWith("same.txt"))).toBe(false);
}, 60_000);

test("special files in .git (a /dev/zero symlink, a FIFO) turn git off instead of exhausting memory", async () => {
  const { symlink } = await import("node:fs/promises");
  for (const [file, how] of [
    ["config", "zero"], ["HEAD", "zero"], ["commondir", "zero"], ["objects/info/alternates", "zero"], ["info/grafts", "zero"],
    ["info/attributes", "fifo"], ["info/exclude", "fifo"], [".git", "fifo"],
  ] as const) {
    const r = path.join(dir, `special-${file.replace(/\W/g, "_")}`);
    await mkdir(r);
    sh(["init", "-q"], r);
    await writeFile(path.join(r, "f.txt"), "x\n");
    sh(["add", "."], r);
    sh(["commit", "-qm", "i"], r);
    const target = file === ".git" ? path.join(r, ".git") : path.join(r, ".git", ...file.split("/"));
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    if (how === "zero") await symlink("/dev/zero", target);
    else Bun.spawnSync(["mkfifo", target]);
    const t0 = performance.now();
    const g = await Git.open(r);
    if (g) {
      await g.status();
      await g.changes("head");
      await g.blame("f.txt", 1);
      g.stop();
    }
    expect([file, performance.now() - t0 < 5000]).toEqual([file, true]);
  }
}, 120_000);

test("git variables inherited from the environment cannot point at another repository", async () => {
  const other = path.join(dir, "other");
  await mkdir(other);
  sh(["init", "-q"], other);
  await writeFile(path.join(other, "secret.txt"), "PRIVATE\n");
  sh(["add", "."], other);
  sh(["commit", "-qm", "s"], other);
  const plain = path.join(dir, "plain");
  await mkdir(plain);
  await writeFile(path.join(plain, "secret.txt"), "x\n");
  // ENV is built when git.ts loads: run in a child with GIT_DIR set, as a hook would.
  const script = `import { Git } from ${JSON.stringify(path.join(import.meta.dir, "..", "src", "server", "git.ts"))};
const g = await Git.open(${JSON.stringify(plain)}); console.log(g ? "repo" : "none");`;
  const p = Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: plain } });
  expect(p.stdout.toString().trim()).toBe("none");
});
