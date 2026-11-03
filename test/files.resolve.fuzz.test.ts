import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openRegular, resolveSafe, within } from "../src/server/files.ts";

// Containment, as a property: whatever relative path a client sends, through whatever symlinks the
// tree holds, resolveSafe answers null or a real path inside the root, and nothing it lets through
// opens a file outside. Seeded and deterministic.

let base = "";
let root = "";
let outside = "";

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "cv-resolve-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await mkdir(path.join(root, "a", "b"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "OUTSIDE");
  await writeFile(path.join(root, "a", "b", "in.txt"), "inside");
  await writeFile(path.join(root, "top.txt"), "inside");
  await symlink(outside, path.join(root, "out-dir"));
  await symlink(path.join(outside, "secret.txt"), path.join(root, "out-file"));
  await symlink("../outside/secret.txt", path.join(root, "a", "rel-out"));
  await symlink("/", path.join(root, "slash"));
  await symlink(path.join(root, "a"), path.join(root, "in-dir"));
  await symlink("b/in.txt", path.join(root, "a", "in-file"));
  await symlink("loop2", path.join(root, "loop1"));
  await symlink("loop1", path.join(root, "loop2"));
  await symlink(base, path.join(root, "a", "up"));
  await symlink("nowhere", path.join(root, "dangling"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const SEGMENTS = [
  "a", "b", "in.txt", "top.txt", "out-dir", "out-file", "rel-out", "slash", "in-dir", "in-file", "loop1", "dangling", "up", "secret.txt",
  "outside", "root", "..", ".", "", "etc", "passwd", "%2e%2e", "..%2f", "\\..", "a\\..\\..", "\0", "~", "C:", "//", " ", "..."
];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32;
}

test("5000 random relative paths never resolve, or open, outside the root", async () => {
  const r = rng(42);
  let resolved = 0;
  for (let k = 0; k < 5000; k++) {
    const n = 1 + Math.floor(r() * 5);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(SEGMENTS[Math.floor(r() * SEGMENTS.length)]!);
    const rel = parts.join(r() < 0.8 ? "/" : r() < 0.5 ? "\\" : "//") + (r() < 0.1 ? "/" : "");
    const abs = await resolveSafe(root, r() < 0.05 ? "/" + rel : rel);
    if (abs === null) continue;
    resolved++;
    if (!within(root, abs)) throw new Error(`${JSON.stringify(rel)} resolved outside: ${abs}`);
    if (realpathSync(abs) !== abs) throw new Error(`${JSON.stringify(rel)} resolved to a non-real path ${abs}`);
    const opened = await openRegular(abs, root).catch(() => null);
    if (opened) {
      const text = new TextDecoder().decode((await opened.fh.read(new Uint8Array(64), 0, 64, 0)).buffer.subarray(0, 64));
      await opened.fh.close();
      if (text.includes("OUTSIDE")) throw new Error(`${JSON.stringify(rel)} opened an outside file`);
    }
  }
  // The generator does reach real files (the property is not vacuously true).
  expect(resolved).toBeGreaterThan(100);
});

test("known escapes are refused one by one", async () => {
  for (const rel of ["out-dir/secret.txt", "out-file", "a/rel-out", "slash/etc/passwd", "a/up/outside/secret.txt", "../outside/secret.txt", "a/../../outside/secret.txt", "/etc/passwd", "a\\..\\..\\outside", "loop1", "dangling", "a/b/in.txt\0x"]) {
    expect([rel, await resolveSafe(root, rel)]).toEqual([rel, null]);
  }
  // In-root symlinks are fine.
  expect(await resolveSafe(root, "in-dir/b/in.txt")).toBe(path.join(root, "a", "b", "in.txt"));
  expect(await resolveSafe(root, "a/in-file")).toBe(path.join(root, "a", "b", "in.txt"));
});
