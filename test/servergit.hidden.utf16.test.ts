import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/server/git.ts";
import { readForView } from "../src/server/files.ts";
import { scanHidden } from "../src/client/hidden.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=Tester", "-c", "user.email=t@example.com", ...cmd], { cwd, stderr: "pipe", env });
  if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr}`);
};
const utf16 = (s: string, le: boolean) => {
  const body = Buffer.from(s, "utf16le");
  return Buffer.concat([Buffer.from(le ? [0xff, 0xfe] : [0xfe, 0xff]), le ? body : body.swap16()]);
};

let dir = "";
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-h16-")));
  sh(dir, "init", "-q", "-b", "main");
  await writeFile(path.join(dir, "seed.txt"), "seed\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  // A bidi override and a zero-width space: the viewer shows both files as text.
  await writeFile(path.join(dir, "le.txt"), utf16("if (admin\u202E) \u200Breturn;\n", true));
  await writeFile(path.join(dir, "be.txt"), utf16("if (admin\u202E) \u200Breturn;\n", false));
  await writeFile(path.join(dir, "clean.txt"), utf16("nothing hidden here\n", true));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("Changes counts hidden characters in UTF-16 files, like the view that opens them", async () => {
  const git = (await Git.open(dir))!;
  const files = (await git.changes("head")).files as { path: string; hidden?: number }[];
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  for (const name of ["le.txt", "be.txt"]) {
    const view = await readForView(path.join(dir, name), false, dir);
    const shown = scanHidden(new TextDecoder().decode(view.body!), 0).count;
    expect(shown).toBe(2);
    expect(by[name]?.hidden).toBe(shown);
  }
  expect("hidden" in by["clean.txt"]!).toBe(false);
});
