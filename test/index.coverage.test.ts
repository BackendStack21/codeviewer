import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, realpath, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileIndex, HEAVY_DIRS } from "../src/server/index.ts";

let root = "";
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "cv-index-")));
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "x"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await writeFile(path.join(root, "top.txt"), "");
  await writeFile(path.join(root, "src", "a.ts"), "");
  await writeFile(path.join(root, "src", "deep", "b.ts"), "");
  await writeFile(path.join(root, "node_modules", "x", "i.js"), "");
  await writeFile(path.join(root, ".git", "HEAD"), "");
});
afterEach(async () => {
  await chmod(path.join(root, "src"), 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

const list = async (ix: FileIndex) => (await ix.get()).split("\n").filter(Boolean).sort();

test("HEAVY_DIRS covers the usual suspects", () => {
  for (const d of [".git", "node_modules", "target", "__pycache__"]) expect(HEAVY_DIRS.has(d)).toBe(true);
});

test("get() walks the tree, skipping heavy dirs, and caches the text", async () => {
  const ix = new FileIndex(root);
  expect(await list(ix)).toEqual(["src/a.ts", "src/deep/b.ts", "top.txt"]);
  expect(await ix.get()).toBe(await ix.get());
});

test("concurrent get() calls share one build", async () => {
  const ix = new FileIndex(root);
  const [a, b] = await Promise.all([ix.get(), ix.get()]);
  expect(a).toBe(b);
});

test("an empty root yields an empty index; a missing root does not throw", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "cv-index-empty-"));
  try {
    expect(await new FileIndex(empty).get()).toBe("");
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
  expect(await new FileIndex(path.join(root, "does-not-exist")).get()).toBe("");
});

test("breadth-first order puts shallow files first", async () => {
  const ix = new FileIndex(root);
  const lines = (await ix.get()).split("\n");
  expect(lines.indexOf("top.txt")).toBeLessThan(lines.indexOf("src/deep/b.ts"));
  expect(lines.indexOf("src/a.ts")).toBeLessThan(lines.indexOf("src/deep/b.ts"));
});

test("unreadable directories are skipped", async () => {
  if (process.getuid?.() === 0) return; // root ignores permissions
  await chmod(path.join(root, "src"), 0o000);
  const ix = new FileIndex(root);
  expect(await list(ix)).toEqual(["top.txt"]);
});

test("apply() before the first build asks for a rebuild (returns true)", async () => {
  expect(await new FileIndex(root).apply(["top.txt"])).toBe(true);
});

test("apply(): content edits are not structural; creates and deletes are", async () => {
  const ix = new FileIndex(root);
  await ix.get();
  expect(await ix.apply(["top.txt"])).toBe(false);

  await writeFile(path.join(root, "src", "new.ts"), "");
  expect(await ix.apply(["src/new.ts"])).toBe(true);
  expect(await list(ix)).toContain("src/new.ts");

  await rm(path.join(root, "src", "new.ts"));
  expect(await ix.apply(["src/new.ts"])).toBe(true);
  expect(await list(ix)).not.toContain("src/new.ts");

  // Deleting something that was never indexed is not a change.
  expect(await ix.apply(["ghost.txt"])).toBe(false);
});

test("apply(): heavy dirs are ignored", async () => {
  const ix = new FileIndex(root);
  await ix.get();
  await writeFile(path.join(root, "node_modules", "x", "j.js"), "");
  expect(await ix.apply(["node_modules/x/j.js"])).toBe(false);
  expect(await list(ix)).not.toContain("node_modules/x/j.js");
});

test("apply(): events for known directories are churn; new directories trigger a rescan", async () => {
  const ix = new FileIndex(root);
  await ix.get();
  expect(await ix.apply(["src", "src/deep"])).toBe(false);

  await mkdir(path.join(root, "fresh"));
  await writeFile(path.join(root, "fresh", "f.txt"), "");
  expect(await ix.apply(["fresh"])).toBe(true);
  // The rescan happens lazily on the next get().
  expect(await list(ix)).toContain("fresh/f.txt");
});

test("apply(): a deleted directory drops everything beneath it", async () => {
  const ix = new FileIndex(root);
  await ix.get();
  await rm(path.join(root, "src"), { recursive: true });
  expect(await ix.apply(["src"])).toBe(true);
  expect(await list(ix)).toEqual(["top.txt"]);
});

test("apply(): huge bursts invalidate and rebuild from disk", async () => {
  const ix = new FileIndex(root);
  await ix.get();
  await writeFile(path.join(root, "late.txt"), "");
  const paths = Array.from({ length: 2001 }, (_, i) => `p${i}`);
  expect(await ix.apply(paths)).toBe(true);
  expect(await list(ix)).toContain("late.txt");
});

test("invalidate() forces a rebuild", async () => {
  const ix = new FileIndex(root);
  await ix.get();
  await writeFile(path.join(root, "added.txt"), "");
  expect(await list(ix)).not.toContain("added.txt");
  ix.invalidate();
  expect(await list(ix)).toContain("added.txt");
});

test("a new file in a freshly added directory is found after dirs cache refresh", async () => {
  const ix = new FileIndex(root);
  await ix.get();
  // Adding a file resets the known-dirs cache so later directory events are judged correctly.
  await writeFile(path.join(root, "src", "c.ts"), "");
  await ix.apply(["src/c.ts"]);
  expect(await ix.apply(["src/deep"])).toBe(false);
});

test("symlinked directories inside the root are walked; links out of the root and cycles are not", async () => {
  const { symlink } = await import("node:fs/promises");
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "cv-index-out-")));
  try {
    await writeFile(path.join(outside, "secret.txt"), "");
    await symlink(path.join(root, "src", "deep"), path.join(root, "linked"));
    await symlink(outside, path.join(root, "out"));
    await symlink(path.join(outside, "secret.txt"), path.join(root, "outfile"));
    await symlink(root, path.join(root, "src", "loop")); // a link to an ancestor
    await symlink(path.join(root, "top.txt"), path.join(root, "src", "toplink"));
    const ix = new FileIndex(root);
    const files = await list(ix);
    expect(files).toContain("linked/b.ts");
    expect(files).toContain("src/toplink");
    expect(files).toContain("src/deep/b.ts");
    expect(files.some((f) => f.startsWith("out"))).toBe(false);
    expect(files.some((f) => f.startsWith("src/loop"))).toBe(false);
    // A symlinked directory is a known directory: events inside it are churn, not a rebuild.
    expect(await ix.apply(["linked"])).toBe(false);
    // A link out of the root is never a reason to rescan.
    expect(await ix.apply(["out"])).toBe(false);
    expect(await list(ix)).toEqual(files);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
