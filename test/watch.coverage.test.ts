import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { watchTree } from "../src/server/watch.ts";

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 8000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await Bun.sleep(25);
  }
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "cv-watch-"));
  dirs.push(root);
  await mkdir(path.join(root, "sub"));
  await mkdir(path.join(root, "node_modules"));
  await mkdir(path.join(root, ".git"));
  return root;
}

test("reports changed paths root-relative, with forward slashes, in batches", async () => {
  const root = await setup();
  const seen = new Set<string>();
  stops.push(watchTree(root, (b) => b.forEach((p) => seen.add(p))));
  await Bun.sleep(100); // let the watcher arm
  await writeFile(path.join(root, "a.txt"), "1");
  await writeFile(path.join(root, "sub", "b.txt"), "2");
  await until(() => seen.has("a.txt") && seen.has("sub/b.txt"));
});

test("ignores .git and node_modules", async () => {
  const root = await setup();
  const seen = new Set<string>();
  stops.push(watchTree(root, (b) => b.forEach((p) => seen.add(p))));
  await Bun.sleep(100);
  await writeFile(path.join(root, ".git", "x"), "1");
  await writeFile(path.join(root, "node_modules", "y"), "1");
  await writeFile(path.join(root, "keep.txt"), "1");
  await until(() => seen.has("keep.txt"));
  await Bun.sleep(200);
  expect([...seen].filter((p) => /\.git|node_modules/.test(p))).toEqual([]);
});

test("stop() prevents further callbacks and is safe to call twice", async () => {
  const root = await setup();
  let calls = 0;
  const stop = watchTree(root, () => calls++);
  await Bun.sleep(100);
  stop();
  stop();
  const before = calls; // FSEvents may replay the setup mkdirs before stop()
  await writeFile(path.join(root, "late.txt"), "1");
  await Bun.sleep(400);
  expect(calls).toBe(before);
});

test("stop() right after an event cancels the pending flush", async () => {
  const root = await setup();
  let calls = 0;
  const stop = watchTree(root, () => calls++);
  await Bun.sleep(100);
  await writeFile(path.join(root, "x.txt"), "1");
  await Bun.sleep(30); // event delivered, 60ms debounce not yet fired (best effort)
  stop();
  const before = calls;
  await Bun.sleep(300);
  expect(calls).toBe(before);
});

test("a nonexistent root yields a harmless no-op watcher", () => {
  const stop = watchTree(path.join(tmpdir(), "cv-definitely-missing-" + Date.now()), () => {});
  expect(() => stop()).not.toThrow();
});
