import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_TEXT_BYTES } from "../src/server/files.ts";
import { done, files, makeServer, type Fx } from "./helpers/searchsrv.ts";

let fx: Fx;
let outside = "";

beforeAll(async () => {
  outside = await mkdtemp(path.join(tmpdir(), "cv-outside-"));
  await writeFile(path.join(outside, "id_rsa"), "needle OUTSIDE-SECRET\n");
  fx = await makeServer(async (dir) => {
    await writeFile(path.join(dir, "a.txt"), "one needle here\nsecond line\n");
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "b.txt"), "needle at start\r\nno\r\nneedle again\n");
    await link(path.join(dir, "a.txt"), path.join(dir, "a-hardlink.txt"));
    await symlink(path.join(outside, "id_rsa"), path.join(dir, "link-out.txt"));
    Bun.spawnSync(["mkfifo", path.join(dir, "pipe.txt")]);
    await writeFile(path.join(dir, "bin.dat"), Buffer.concat([Buffer.from("needle\0\0needle"), Buffer.alloc(64)]));
    await writeFile(path.join(dir, "big.txt"), "needle ".repeat(Math.ceil((MAX_TEXT_BYTES + 16) / 7)));
  });
});
afterAll(async () => {
  await fx.stop();
  await rm(outside, { recursive: true, force: true });
});

describe("GET /api/search NDJSON (AC-5)", () => {
  test("200 application/x-ndjson, file lines then a final done line", async () => {
    const r = await fx.search({ q: "needle" });
    expect(r.status).toBe(200);
    expect(r.type).toContain("application/x-ndjson");
    expect(r.events.length).toBeGreaterThan(1);
    expect(r.events.at(-1)!.t).toBe("done");
    expect(r.events.filter((e) => e.t === "done").length).toBe(1);
    const fl = files(r.events);
    const byPath = new Map(fl.map((f) => [f.path, f]));
    expect(byPath.get("a.txt")?.matches).toEqual([{ line: 1, col: 4, len: 6, preview: "one needle here", pcol: 4 }]);
    const b = byPath.get("sub/b.txt")!;
    expect(b.matches.map((m) => m.line)).toEqual([1, 3]);
    const d = done(r.events)!;
    expect(d.files).toBe(fl.length);
    expect(d.matches).toBe(fl.reduce((n, f) => n + f.matches.length, 0));
    expect(typeof d.skipped).toBe("number");
    expect(d.truncated).toBe(false);
    expect(typeof d.ms).toBe("number");
  });
  test("no matches still ends with done", async () => {
    const r = await fx.search({ q: "zzz-not-present" });
    expect(r.status).toBe(200);
    expect(files(r.events)).toEqual([]);
    expect(done(r.events)).toMatchObject({ files: 0, matches: 0, truncated: false });
  });
  test("requires the token", async () => {
    const r = await fetch(`${fx.base}/api/search?q=needle`);
    expect(r.status).toBe(401);
  });
});

describe("GET /api/search errors (AC-6)", () => {
  const bad: [string, Record<string, string>][] = [
    ["missing query", {}],
    ["empty query", { q: "" }],
    ["too long", { q: "a".repeat(257) }],
    ["control char", { q: "a\nb" }],
    ["invalid regex", { q: "(", regex: "1" }],
  ];
  for (const [name, params] of bad) {
    test(`${name} -> 400 {error} with no absolute path`, async () => {
      const r = await fx.search(params);
      expect(r.status).toBe(400);
      expect(r.type).toContain("application/json");
      const body = JSON.parse(r.text) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
      expect(r.text).not.toContain(fx.dir);
      expect(r.text).not.toMatch(/\/(tmp|var|Users|home)\//);
    });
  }
});

describe("containment and skips (AC-7)", () => {
  test("symlink, FIFO, binary and oversized files are never read or matched", async () => {
    const r = await fx.search({ q: "needle" });
    expect(r.status).toBe(200);
    const paths = files(r.events).map((f) => f.path);
    for (const p of ["link-out.txt", "pipe.txt", "bin.dat", "big.txt"]) expect(paths).not.toContain(p);
    expect(r.text).not.toContain("OUTSIDE-SECRET");
    // symlink + binary + oversized are certain skips (a FIFO may be filtered earlier or counted too).
    expect(done(r.events)!.skipped).toBeGreaterThanOrEqual(3);
  });
  test("hard links sharing dev:ino are scanned once", async () => {
    const r = await fx.search({ q: "one needle" });
    const paths = files(r.events).map((f) => f.path).filter((p) => p === "a.txt" || p === "a-hardlink.txt");
    expect(paths.length).toBe(1);
  });
});

describe("option params (AC-25)", () => {
  let o: Fx;
  beforeAll(async () => {
    o = await makeServer(async (dir) => {
      await writeFile(path.join(dir, "t.txt"), ["Foo", "foo", "FOO", "foobar", "a.b", "axb", "foooo"].join("\n") + "\n");
    });
  });
  afterAll(() => o.stop());
  const lines = async (p: Record<string, string>) => {
    const r = await o.search(p);
    expect(r.status).toBe(200);
    return files(r.events).flatMap((f) => f.matches.map((m) => m.line));
  };
  test("absent params: case-insensitive literal", async () => {
    expect(await lines({ q: "foo" })).toEqual([1, 2, 3, 4, 7]);
    expect(await lines({ q: "a.b" })).toEqual([5]);
  });
  test("case=1 is case-sensitive", async () => {
    expect(await lines({ q: "foo", case: "1" })).toEqual([2, 4, 7]);
  });
  test("word=1 is whole-word", async () => {
    expect(await lines({ q: "foo", word: "1" })).toEqual([1, 2, 3]);
  });
  test("regex=1 treats the query as a pattern", async () => {
    expect(await lines({ q: "a.b", regex: "1" })).toEqual([5, 6]);
    expect(await lines({ q: "^fo+$", regex: "1", case: "1" })).toEqual([2, 7]);
  });
  test("options combine", async () => {
    expect(await lines({ q: "fo+", regex: "1", word: "1", case: "1" })).toEqual([2, 7]);
  });
});

describe("match cap (AC-8)", () => {
  let c: Fx;
  beforeAll(async () => {
    c = await makeServer(async (dir) => {
      for (let i = 0; i < 30; i++) await writeFile(path.join(dir, `f${String(i).padStart(2, "0")}.txt`), "zzcap ".repeat(150) + "\n");
    });
  });
  afterAll(() => c.stop());
  test("stops at 2,000 total matches with truncated === matches", async () => {
    const r = await c.search({ q: "zzcap" });
    expect(r.status).toBe(200);
    const d = done(r.events)!;
    expect(d.truncated).toBe("matches");
    expect(d.matches).toBe(2000);
    const fl = files(r.events);
    expect(fl.reduce((n, f) => n + f.matches.length, 0)).toBe(2000);
    expect(fl.every((f) => f.matches.length <= 100)).toBe(true);
    expect(fl.some((f) => (f.more ?? 0) > 0)).toBe(true);
  });
});

describe("no query logging (AC-27)", () => {
  const Q = "s3cr3t-needle-xyz";
  test("console never sees the query on success, 400 or internal failure", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => spyOn(console, k).mockImplementation(() => {}));
    const w = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const o = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    let failing: Fx | undefined;
    try {
      expect((await fx.search({ q: Q })).status).toBe(200);
      expect((await fx.search({ q: Q + "(", regex: "1" })).status).toBe(400);
      failing = await makeServer(async () => {}, {
        searchScanner: async () => {
          throw new Error("boom");
        },
      });
      await failing.search({ q: Q });
      const seen = [...spies.flatMap((s) => s.mock.calls), ...w.mock.calls, ...o.mock.calls].map((c) => c.map(String).join(" ")).join("\n");
      expect(seen).not.toContain(Q);
    } finally {
      for (const s of spies) s.mockRestore();
      w.mockRestore();
      o.mockRestore();
      await failing?.stop();
    }
  });
});

describe("top-level failure (AC-28)", () => {
  test("response is a fixed string without the path or e.message", async () => {
    let dirSeen = "";
    const f = await makeServer(async () => {}, {
      searchScanner: async (req) => {
        dirSeen = req.root;
        throw new Error(`ENOENT: no such file, open '${req.root}/secret/id_rsa'`);
      },
    });
    try {
      const r = await f.search({ q: "x" });
      expect(dirSeen).toBe(f.dir);
      expect(r.status).toBe(500);
      const body = JSON.parse(r.text) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(r.text).not.toContain(f.dir);
      expect(r.text).not.toContain("ENOENT");
      expect(r.text).not.toContain("id_rsa");
    } finally {
      await f.stop();
    }
  });
});
