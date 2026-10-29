import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let S: typeof import("../src/client/search.ts");
beforeAll(async () => {
  installDom();
  // Loaded dynamically so a missing module fails the tests by assertion, not by a load error.
  try {
    S = await import("../src/client/search.ts");
  } catch {}
});
afterAll(() => uninstallDom());

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nd = (...evs: unknown[]) => evs.map((e) => JSON.stringify(e) + "\n").join("");
type M = { line: number; col: number; len: number; preview: string; pcol: number };
const m = (line: number, preview: string, pcol: number, len: number): M => ({ line, col: pcol, len, preview, pcol });
const file = (path: string) => ({ t: "file" as const, path, matches: [m(1, "needle", 0, 6)] });
const done = () => ({ t: "done" as const, files: 2, matches: 2, skipped: 0, truncated: false as const, ms: 1 });

/** A controllable NDJSON response body. */
function stream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctl = c) });
  return {
    response: () => new Response(body),
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    close: () => ctl.close(),
  };
}

describe("SearchView staleness while streaming (SL06 R-01)", () => {
  beforeEach(() => {
    expect(S?.SearchView).toBeDefined();
  });
  let restore = () => {};
  afterEach(() => restore());

  const make = (...streams: ReturnType<typeof stream>[]) => {
    let n = 0;
    const r = mockFetch(() => streams[n++]!.response());
    restore = r.restore;
    const v = new S.SearchView({ debounce: 0 }) as InstanceType<typeof S.SearchView> & { markStale(paths: string[], many?: boolean): void };
    const root = v.el as unknown as FakeElement;
    const input = root.querySelector(".sv-query")!;
    const bar = () => root.querySelector(".sv-stale");
    const visible = () => !!bar() && !bar()!.hidden && /out of date/i.test(bar()!.textContent);
    const results = () => root.querySelector(".sv-results")!;
    const flush = async () => {
      for (let i = 0; i < 8; i++) await sleep(0);
    };
    const search = async (q = "needle") => {
      input.value = q;
      input.dispatchEvent(new FakeEvent("input"));
      await flush();
    };
    return { v, visible, results, flush, search };
  };

  test("a change for a path already shown, while streaming, shows the bar", async () => {
    const s = stream();
    const t = make(s);
    await t.search();
    s.push(nd(file("src/a.ts")));
    await t.flush();
    t.v.markStale(["src/a.ts"]);
    expect(t.visible()).toBe(true);
    s.push(nd(done()));
    s.close();
    await t.flush();
    expect(t.visible()).toBe(true);
  });

  test("a change for a path that arrives later in the same stream shows the bar at stream end", async () => {
    const s = stream();
    const t = make(s);
    await t.search();
    s.push(nd(file("src/a.ts")));
    await t.flush();
    t.v.markStale(["src/b.ts"]);
    expect(t.visible()).toBe(false);
    s.push(nd(file("src/b.ts"), done()));
    s.close();
    await t.flush();
    expect(t.visible()).toBe(true);
  });

  test("a changed path that never arrives leaves the bar hidden at stream end", async () => {
    const s = stream();
    const t = make(s);
    await t.search();
    s.push(nd(file("src/a.ts")));
    await t.flush();
    t.v.markStale(["src/zzz.ts"]);
    s.push(nd(done()));
    s.close();
    await t.flush();
    expect(t.visible()).toBe(false);
  });

  test("a many-changes event during streaming shows the bar at stream end", async () => {
    const s = stream();
    const t = make(s);
    await t.search();
    t.v.markStale([], true);
    s.push(nd(file("src/a.ts"), done()));
    s.close();
    await t.flush();
    expect(t.visible()).toBe(true);
  });

  test("a new query discards the pending stale state", async () => {
    const s1 = stream();
    const s2 = stream();
    const t = make(s1, s2);
    await t.search();
    t.v.markStale(["src/b.ts"], true);
    await t.search("other");
    s2.push(nd(file("src/b.ts"), done()));
    s2.close();
    await t.flush();
    expect(t.visible()).toBe(false);
  });
});

describe("SearchView early end with no matches (SL06 R-02)", () => {
  beforeEach(() => {
    expect(S?.SearchView).toBeDefined();
  });
  let restore = () => {};
  afterEach(() => restore());

  test("an empty stream without done shows the early-end note, not No results", async () => {
    const r = mockFetch(() => new Response(""));
    restore = r.restore;
    const v = new S.SearchView({ debounce: 0 });
    const root = v.el as unknown as FakeElement;
    const input = root.querySelector(".sv-query")!;
    input.value = "needle";
    input.dispatchEvent(new FakeEvent("input"));
    await sleep(100);
    const html = root.querySelector(".sv-results")!.innerHTML;
    expect(html).toContain("Search ended early");
    expect(html).not.toContain("No results for");
  });

  test("a complete empty search still says No results", async () => {
    const r = mockFetch(() => new Response(nd(done())));
    restore = r.restore;
    const v = new S.SearchView({ debounce: 0 });
    const root = v.el as unknown as FakeElement;
    const input = root.querySelector(".sv-query")!;
    input.value = "needle";
    input.dispatchEvent(new FakeEvent("input"));
    await sleep(100);
    const html = root.querySelector(".sv-results")!.innerHTML;
    expect(html).toContain("No results for");
    expect(html).not.toContain("ended early");
  });
});
