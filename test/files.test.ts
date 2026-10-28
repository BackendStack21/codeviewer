import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSafe, looksBinary, readForView, listDir, toRel } from "../src/server/files.ts";

let root = "";
let outside = "";

beforeAll(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "cv-test-")));
  root = path.join(base, "root");
  outside = path.join(base, "outside.txt");
  await mkdir(path.join(root, "src/deep"), { recursive: true });
  await writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "bin.dat"), new Uint8Array([1, 2, 0, 3]));
  await writeFile(path.join(root, "pic.png"), new Uint8Array([0x89, 0x50]));
  await writeFile(outside, "secret");
  await symlink(outside, path.join(root, "escape"));
  await symlink(path.join(root, "src/a.ts"), path.join(root, "inside-link"));
  await symlink(path.join(root, "missing"), path.join(root, "broken"));
});

afterAll(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

describe("path safety", () => {
  test("resolves paths inside the root", async () => {
    expect(await resolveSafe(root, "")).toBe(root);
    expect(await resolveSafe(root, "src/a.ts")).toBe(path.join(root, "src/a.ts"));
    expect(await resolveSafe(root, "inside-link")).toBe(path.join(root, "src/a.ts"));
  });

  test("rejects traversal, absolute paths, NUL and symlink escapes", async () => {
    for (const p of ["..", "../outside.txt", "src/../../outside.txt", "/etc/passwd", "a\0b", "escape", "broken", "C:/x"]) {
      expect(await resolveSafe(root, p)).toBeNull();
    }
  });

  test("toRel", () => {
    expect(toRel(root, path.join(root, "src/a.ts"))).toBe("src/a.ts");
    expect(toRel(root, "/etc/hosts")).toBeNull();
    expect(toRel(root, root + "-sibling/x")).toBeNull();
  });
});

describe("file reading", () => {
  test("sniffs binary, image and text", async () => {
    expect(looksBinary(new Uint8Array([65, 0, 66]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("plain"))).toBe(false);
    expect((await readForView(path.join(root, "bin.dat"))).meta.kind).toBe("binary");
    expect((await readForView(path.join(root, "pic.png"))).meta.kind).toBe("image");
    const t = await readForView(path.join(root, "src/a.ts"));
    expect(t.meta.kind).toBe("text");
    expect(new TextDecoder().decode(t.body)).toBe("export const a = 1;\n");
  });

  test("lists directories first, with symlink info", async () => {
    const list = await listDir(root);
    expect(list[0]).toEqual({ name: "src", type: "dir" });
    expect(list.find((e) => e.name === "broken")?.type).toBe("link-broken");
    expect(list.find((e) => e.name === "inside-link")).toEqual({ name: "inside-link", type: "file", link: true });
  });
});

import { compareNames } from "../src/server/files.ts";
test("natural name order (ASCII fast path agrees with the collator)", () => {
  const names = ["file10.ts", "File2.ts", "file1.ts", "a", "B", "file02.ts", "z9", "z10", "über", "Zeta", ".env", "_x"];
  const fast = [...names].sort(compareNames);
  expect(fast.slice(0, 2)).toEqual([".env", "_x"]);
  expect(fast.indexOf("file1.ts")).toBeLessThan(fast.indexOf("File2.ts"));
  expect(fast.indexOf("File2.ts")).toBeLessThan(fast.indexOf("file10.ts"));
  expect(fast.indexOf("z9")).toBeLessThan(fast.indexOf("z10"));
  // Relative, so it holds on slow CI runners: the fast path must clearly beat the collator.
  const big = Array.from({ length: 52_000 }, (_, i) => `module_${(i * 7919) % 52_000}.ts`);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  let t = performance.now();
  [...big].sort(collator.compare);
  const slow = performance.now() - t;
  t = performance.now();
  [...big].sort(compareNames);
  expect(performance.now() - t).toBeLessThan(slow);
});

test("UTF-16 files are transcoded", async () => {
  const p = path.join(root, "u16.txt");
  await writeFile(p, new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]));
  const r = await readForView(p);
  expect(r.meta.encoding).toBe("UTF-16 LE");
  expect(new TextDecoder().decode(r.body)).toBe("hi");
});
