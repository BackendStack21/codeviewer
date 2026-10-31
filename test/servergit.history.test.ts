import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Git, MAX_HISTORY, parseHistory } from "../src/server/git.ts";
import { startServer } from "../src/server/http.ts";

// Captured at load: other test files may swap globalThis.fetch for mocks.
const fetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch;
const token = "H".repeat(43);
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("parseHistory", () => {
  test("reads header fields and status records by position, newest first", () => {
    const out = [A, B, "Ann", "1700000000", "fix: x", "\nM", "src/a.ts", B, "", "Bob", "1600000000", "init", "\nA", "src/a.ts", ""].join("\0");
    expect(parseHistory(out)).toEqual([
      { oid: A, parent: B, author: "Ann", time: 1700000000000, subject: "fix: x", path: "src/a.ts", status: "M" },
      { oid: B, parent: null, author: "Bob", time: 1600000000000, subject: "init", path: "src/a.ts", status: "A" },
    ]);
  });
  test("renames keep the old path; merges take the first parent", () => {
    const out = [A, `${B} ${C}`, "Ann", "1", "move", "\nR087", "old/a.ts", "new/a.ts", ""].join("\0");
    expect(parseHistory(out)[0]).toMatchObject({ parent: B, path: "new/a.ts", oldPath: "old/a.ts", status: "R" });
  });
  test("subjects and names that look like records or ids are data, not separators", () => {
    const out = [A, B, C, "1", "M", "\nM", "a.ts", B, "", "x\x1ey", "2", A, "\nA", "a.ts", ""].join("\0");
    const h = parseHistory(out);
    expect(h.map((e) => [e.oid, e.author, e.subject])).toEqual([[A, C, "M"], [B, "x\x1ey", A]]);
  });
  test("paths are made root-relative; a rename from outside the root ends as added", () => {
    const out = [A, B, "Ann", "1", "in", "\nR100", "other/a.ts", "sub/a.ts", B, C, "Ann", "1", "old", "\nM", "other/a.ts", ""].join("\0");
    expect(parseHistory(out, "sub/")).toEqual([{ oid: A, parent: B, author: "Ann", time: 1000, subject: "in", path: "a.ts", status: "A" }]);
  });
  test("a commit without a file record (a merge on old git) is skipped", () => {
    const out = [A, `${B} ${C}`, "Ann", "1", "Merge", B, C, "Bob", "1", "work", "\nM", "a.ts", ""].join("\0");
    expect(parseHistory(out).map((e) => e.oid)).toEqual([B]);
  });
});

describe("Git.history and /api/git/history", () => {
  let dir = "";
  let cfg = "";
  let app: ReturnType<typeof startServer>;
  let base = "";
  const saved: Record<string, string | undefined> = {};
  const git = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=Tester", "-c", "user.email=t@t", ...a], { cwd: dir, stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const oids: string[] = [];

  beforeAll(async () => {
    for (const k of ["XDG_CONFIG_HOME", "CODEVIEWER_NO_UPDATE_CHECK"]) saved[k] = process.env[k];
    cfg = await realpath(await mkdtemp(path.join(tmpdir(), "cv-cfg-")));
    process.env.XDG_CONFIG_HOME = cfg;
    process.env.CODEVIEWER_NO_UPDATE_CHECK = "1";
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-hist-")));
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "old.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
    await writeFile(path.join(dir, ":(top)weird.txt"), "x\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    oids.push(git("rev-parse", "HEAD"));
    git("mv", "sub/old.ts", "sub/new.ts");
    git("commit", "-q", "-m", "rename");
    oids.push(git("rev-parse", "HEAD"));
    await writeFile(path.join(dir, "sub", "new.ts"), "export const a = 1;\nexport const b = 20;\nexport const c = 3;\n");
    git("commit", "-qam", "change b");
    oids.push(git("rev-parse", "HEAD"));
    await writeFile(path.join(dir, "sub", "new.ts"), "uncommitted\n");
    app = startServer({ root: dir, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {} });
    base = app.url.split("/#")[0]!;
  });
  afterAll(async () => {
    app.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
    await rm(cfg, { recursive: true, force: true });
  });

  test("follows renames, newest first, committed changes only", async () => {
    const g = (await Git.open(dir))!;
    const h = (await g.history("sub/new.ts"))!;
    expect(h.map((e) => `${e.status} ${e.subject} ${e.oldPath ?? ""}→${e.path}`)).toEqual([
      "M change b →sub/new.ts",
      "R rename sub/old.ts→sub/new.ts",
      "A first →sub/old.ts",
    ]);
    expect(h.map((e) => e.oid)).toEqual([...oids].reverse());
    expect(h[0]!.parent).toBe(oids[1]!);
    expect(h[2]!.parent).toBeNull();
    expect(h[0]!.author).toBe("Tester");
    expect(MAX_HISTORY).toBe(500);
  });

  test("with the served root a subfolder, paths are relative to it", async () => {
    const g = (await Git.open(path.join(dir, "sub")))!;
    const h = (await g.history("new.ts"))!;
    expect(h.map((e) => `${e.oldPath ?? ""}→${e.path}`)).toEqual(["→new.ts", "old.ts→new.ts", "→old.ts"]);
  });

  test("the path is a literal pathspec, never pathspec magic", async () => {
    const g = (await Git.open(dir))!;
    const h = (await g.history(":(top)weird.txt"))!;
    expect(h.map((e) => e.path)).toEqual([":(top)weird.txt"]);
  });

  test("the route needs auth and a path inside the root that exists", async () => {
    const get = (p: string) => fetch(`${base}${p}`, { headers: { "x-cv-token": token } });
    const r = await get("/api/git/history?path=sub/new.ts");
    expect(r.status).toBe(200);
    const h = (await r.json()) as { subject: string; oid: string; parent: string | null; oldPath?: string; path: string }[];
    expect(h.map((e) => e.subject)).toEqual(["change b", "rename", "first"]);
    // Each entry's sides load through /api/git/base, which serves files by commit.
    const before = await (await get(`/api/git/base?path=${h[0]!.path}&rev=${h[0]!.parent}`)).text();
    const after = await (await get(`/api/git/base?path=${h[0]!.path}&rev=${h[0]!.oid}`)).text();
    expect(before).toContain("b = 2;");
    expect(after).toContain("b = 20;");
    expect((await get("/api/git/history?path=../etc/passwd")).status).toBe(404);
    expect((await get("/api/git/history?path=sub/missing.ts")).status).toBe(404);
    expect((await get("/api/git/history?path=")).status).toBe(404);
    expect((await fetch(`${base}/api/git/history?path=sub/new.ts`)).status).toBe(401);
  });
});
