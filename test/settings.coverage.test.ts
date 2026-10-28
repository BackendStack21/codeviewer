import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configDir, Settings } from "../src/server/settings.ts";

let tmp = "";
let saved: string | undefined;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "cv-settings-"));
  saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
  await rm(tmp, { recursive: true, force: true });
});

test("configDir honours XDG_CONFIG_HOME and otherwise falls back per platform", () => {
  expect(configDir()).toBe(path.join(tmp, "codeviewer"));
  delete process.env.XDG_CONFIG_HOME;
  const d = configDir();
  expect(d.endsWith(path.join("codeviewer"))).toBe(true);
  if (process.platform === "darwin") expect(d).toContain(path.join("Library", "Application Support"));
  else expect(d).toContain(path.join(".config", "codeviewer"));
});

test("read returns {} for missing, corrupt, array and scalar files", async () => {
  const s = new Settings();
  expect(await s.read()).toEqual({});
  const dir = configDir();
  await mkdir(dir, { recursive: true });
  const f = path.join(dir, "settings.json");
  for (const bad of ["{nope", "[1,2]", "42", "null"]) {
    await writeFile(f, bad);
    expect(await s.read()).toEqual({});
  }
});

test("write persists atomically with private permissions and round-trips", async () => {
  const s = new Settings();
  await s.write({ theme: "dark", n: 1 });
  expect(await s.read()).toEqual({ theme: "dark", n: 1 });
  const dir = configDir();
  expect(await readdir(dir)).toEqual(["settings.json"]); // no tmp leftovers
  if (process.platform !== "win32") {
    expect((await stat(path.join(dir, "settings.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  }
  expect(JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8")).theme).toBe("dark");
});

test("write rejects non-objects", async () => {
  const s = new Settings();
  for (const bad of [null, undefined, 1, "x", [1]]) await expect(s.write(bad)).rejects.toThrow("object expected");
});

test("concurrent writes are serialized: the last one wins and the file is never torn", async () => {
  const s = new Settings();
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.write({ i })));
  expect(await s.read()).toEqual({ i: 19 });
});

test("a failed write does not poison later writes", async () => {
  const s = new Settings();
  // Make the config dir path a file so mkdir fails.
  await writeFile(path.join(tmp, "codeviewer"), "block");
  await expect(s.write({ a: 1 })).rejects.toBeTruthy();
  await rm(path.join(tmp, "codeviewer"));
  await s.write({ a: 2 });
  expect(await s.read()).toEqual({ a: 2 });
});
