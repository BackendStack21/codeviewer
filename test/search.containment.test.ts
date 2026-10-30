import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as S from "../src/server/search.ts";
import { done, files, makeServer, type Fx } from "./helpers/searchsrv.ts";

let tmp = "";
let root = "";
let fx: Fx;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(path.join(tmpdir(), "cv-contain-")));
  root = path.join(tmp, "root");
  const outside = path.join(tmp, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "needle OUTSIDE-SECRET\n");
  await writeFile(path.join(root, "ok.txt"), "needle ok\n");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link-file.txt"));
  await symlink(outside, path.join(root, "linkdir"));
  fx = await makeServer(async () => {}, { root });
});
afterAll(async () => {
  await fx.stop();
  await rm(tmp, { recursive: true, force: true });
});

describe("escaping candidates are counted in skipped (AC-7)", () => {
  test("HTTP: ok.txt matches; the file symlink and the dir symlink are never candidates (the index drops escaping links)", async () => {
    const r = await fx.search({ q: "needle" });
    expect(r.status).toBe(200);
    expect(files(r.events).map((f) => f.path)).toEqual(["ok.txt"]);
    expect(done(r.events)).toMatchObject({ files: 1, matches: 1, skipped: 0, truncated: false });
    expect(r.text).not.toContain("OUTSIDE-SECRET");
    expect(r.text).not.toContain("link-file");
    expect(r.text).not.toContain("linkdir");
  });

  test("worker: a file under a symlinked dir and a symlinked file are each skipped, never read", async () => {
    const events: S.SearchEvent[] = [];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    await S.createWorkerScanner()(
      { root, files: ["ok.txt", "linkdir/secret.txt", "link-file.txt", "missing.txt"], q: "needle", opts: {} },
      ac.signal,
      (e) => events.push(e),
    );
    clearTimeout(timer);
    const d = events.find((e) => e.t === "done") as Extract<S.SearchEvent, { t: "done" }>;
    // The two symlink escapes are skipped; a candidate deleted since it was listed is simply gone.
    expect(d).toMatchObject({ files: 1, matches: 1, skipped: 2, truncated: false });
    expect(JSON.stringify(events)).not.toContain("OUTSIDE-SECRET");
  });
});

describe("include/exclude caps (400 with a fixed string)", () => {
  const body = async (p: Record<string, string>) => {
    const r = await fx.raw({ q: "needle", ...p }, { signal: AbortSignal.timeout(15_000) });
    return { status: r.status, type: r.headers.get("content-type") ?? "", text: await r.text() };
  };
  for (const key of ["include", "exclude"] as const) {
    test(`${key} longer than 1,024 chars is rejected, exactly 1,024 is accepted`, async () => {
      const bad = await body({ [key]: "a".repeat(1025) });
      expect(bad.status).toBe(400);
      expect(bad.type).toContain("application/json");
      const err = (JSON.parse(bad.text) as { error: unknown }).error;
      expect(typeof err).toBe("string");
      expect(bad.text).not.toContain(tmp);
      expect((await body({ [key]: "a".repeat(1024) })).status).toBe(200);
    });
    test(`${key} with more than 64 patterns is rejected, exactly 64 is accepted`, async () => {
      const many = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`).join(",");
      const bad = await body({ [key]: many(65) });
      expect(bad.status).toBe(400);
      expect(typeof (JSON.parse(bad.text) as { error: unknown }).error).toBe("string");
      expect(bad.text).not.toContain(tmp);
      expect((await body({ [key]: many(64) })).status).toBe(200);
    });
  }
  test("the 400 never echoes the globs", async () => {
    const r = await body({ include: "SECRETGLOB".repeat(200) });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain("SECRETGLOB");
  });
});
