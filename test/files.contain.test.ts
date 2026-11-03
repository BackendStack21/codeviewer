import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openRegular, readForView } from "../src/server/files.ts";
import { FileIndex } from "../src/server/index.ts";

let root = "";
let outside = "";
beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "cv-contain-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "cv-contain-out-")));
  await mkdir(path.join(outside, "d"));
  await writeFile(path.join(outside, "d", "f"), "OUTSIDE");
  await mkdir(path.join(root, "in"));
  await writeFile(path.join(root, "in", "f"), "inside");
  // What a parent swapped for a symlink after resolveSafe() looks like to open().
  await symlink(path.join(outside, "d"), path.join(root, "race"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("openRegular with a root refuses a file reached through a parent symlink out of it", async () => {
  await expect(openRegular(path.join(root, "race", "f"), root)).rejects.toThrow("file changed while opening");
  await expect(readForView(path.join(root, "race", "f"), false, root)).rejects.toThrow();
  const ok = await openRegular(path.join(root, "in", "f"), root);
  await ok.fh.close();
});

test("FileIndex: a file created while the index is being built is not lost", async () => {
  const ix = new FileIndex(root);
  const first = ix.get();
  await writeFile(path.join(root, "NEW.txt"), "");
  // The watcher reports it while the build is still walking (files not yet stored).
  await ix.apply(["NEW.txt"]);
  await first;
  expect((await ix.get()).split("\n")).toContain("NEW.txt");
});
