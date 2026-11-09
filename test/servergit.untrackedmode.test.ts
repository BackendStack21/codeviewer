import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git } from "../src/server/git.ts";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

test("untrackedMode: parent resolving outside the root or a vanished file yields no mode", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-umode-")));
  const outside = path.join(dir, "outside");
  const root = path.join(dir, "root");
  await mkdir(outside);
  await mkdir(path.join(root, "sub"), { recursive: true });
  const r = Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root, env });
  expect(r.exitCode).toBe(0);
  await writeFile(path.join(outside, "secret.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(path.join(root, "sub", "ok.sh"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync(outside, path.join(root, "linkdir"));
  const g = (await Git.open(root))!;
  expect(g).not.toBeNull();
  try {
    const mode = (rel: string) => (g as unknown as { untrackedMode(p: string): string | undefined }).untrackedMode(rel);
    expect(mode("sub/ok.sh")).toBe("100755"); // inside the root: reported
    expect(mode("linkdir/secret.sh")).toBeUndefined(); // parent resolves outside: nothing read
    expect(mode("sub/gone.sh")).toBeUndefined(); // lstat fails: no throw
    expect(mode("nodir/x.sh")).toBeUndefined(); // parent missing: no throw
  } finally {
    g.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
