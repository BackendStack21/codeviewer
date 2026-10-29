import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as S from "../src/server/search.ts";
import { done, files, makeServer, type Fx } from "./helpers/searchsrv.ts";

// Every search here runs in the server's Worker under a bounded deadline; nothing runs the
// catastrophic pattern in the test process, and every fetch carries its own timeout.

// JSC gives up on this pattern after ~0.5 s (backtrack limit), so the injected deadline is shorter than that.
const DEADLINE = 250;
const EVIL = { q: "(a+)+$", regex: "1" };
let fx: Fx;

beforeAll(async () => {
  fx = await makeServer(
    async (dir) => {
      await writeFile(path.join(dir, "evil.txt"), "a".repeat(40) + "b\n");
      await writeFile(path.join(dir, "plain.txt"), "hello world\n");
    },
    { searchDeadlineMs: DEADLINE },
  );
});
afterAll(() => fx.stop());

test("constants: 10 s deadline, 2,000 match cap", () => {
  expect(S.SEARCH_DEADLINE_MS).toBe(10_000);
  expect(S.MAX_TOTAL_MATCHES).toBe(2000);
});

describe("regex DoS (AC-10)", () => {
  test("/(a+)+$/ on a*40+b ends at the deadline with truncated=time; loop stays live; worker is gone", async () => {
    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const n = performance.now();
      maxGap = Math.max(maxGap, n - last);
      last = n;
    }, 20);
    const t0 = performance.now();
    let r;
    try {
      r = await fx.search(EVIL, 8000);
    } finally {
      clearInterval(timer);
    }
    const elapsed = performance.now() - t0;
    expect(r.status).toBe(200);
    const d = done(r.events);
    expect(d?.truncated).toBe("time");
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE - 50);
    expect(elapsed).toBeLessThan(DEADLINE + 3000);
    expect(d!.ms).toBeGreaterThanOrEqual(DEADLINE - 50);
    // The main thread (which carries the PTYs) was never blocked by the pattern.
    expect(maxGap).toBeLessThan(750);
    // terminate() really stopped it: no thread is still burning CPU afterwards.
    await Bun.sleep(300);
    const c0 = process.cpuUsage();
    await Bun.sleep(700);
    const c = process.cpuUsage(c0);
    expect((c.user + c.system) / 1000).toBeLessThan(400);
    // and the server still answers a normal search.
    const ok = await fx.search({ q: "hello" }, 5000);
    expect(done(ok.events)).toMatchObject({ matches: 1, truncated: false });
  }, 20_000);
});

describe("cancellation (AC-9)", () => {
  test("a newer search cancels the running one and answers promptly", async () => {
    const slow = new AbortController();
    const first = fx.raw(EVIL, { signal: slow.signal }).then(async (r) => ({ status: r.status, body: await r.text() }));
    first.catch(() => {});
    await Bun.sleep(300);
    const t0 = performance.now();
    const second = await fx.search({ q: "hello" }, 5000);
    expect(performance.now() - t0).toBeLessThan(1200);
    expect(done(second.events)).toMatchObject({ matches: 1, truncated: false });
    // The first stream is cut short (well before its own 1.5 s deadline would matter) and never reports success.
    const res = await Promise.race([first, Bun.sleep(4000).then(() => "hung" as const)]);
    slow.abort();
    expect(res).not.toBe("hung");
    if (res !== "hung") expect(res.body).not.toContain('"truncated":false');
  }, 20_000);

  test("aborting the request cancels the search and the server stays responsive", async () => {
    const ac = new AbortController();
    const p = fx.raw(EVIL, { signal: ac.signal }).then((r) => r.text()).catch(() => "aborted");
    await Bun.sleep(300);
    ac.abort();
    await p;
    const t0 = performance.now();
    const info = await fetch(`${fx.base}/api/info`, { headers: { "x-cv-token": "T".repeat(43) }, signal: AbortSignal.timeout(3000) });
    expect(info.status).toBe(200);
    const ok = await fx.search({ q: "hello" }, 5000);
    expect(done(ok.events)?.matches).toBe(1);
    expect(performance.now() - t0).toBeLessThan(1500);
    // the cancelled worker is not left spinning
    await Bun.sleep(300);
    const c0 = process.cpuUsage();
    await Bun.sleep(700);
    const c = process.cpuUsage(c0);
    expect((c.user + c.system) / 1000).toBeLessThan(400);
  }, 20_000);

  test("a normal search streams its file lines through the worker", async () => {
    const r = await fx.search({ q: "hello" }, 5000);
    expect(files(r.events).map((f) => f.path)).toEqual(["plain.txt"]);
  });
});

describe("compiled binary (constraint)", () => {
  test("scripts/build.ts bundles the worker entry into the --compile command", async () => {
    const src = await Bun.file(path.join(import.meta.dir, "../scripts/build.ts")).text();
    const m = src.match(/const cmd = \[[^\]]*"--compile"[^\]]*\]/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("src/server/search.worker.ts");
  });
  test("the worker entry exists next to search.ts", async () => {
    expect(await Bun.file(path.join(import.meta.dir, "../src/server/search.worker.ts")).exists()).toBe(true);
  });
});
