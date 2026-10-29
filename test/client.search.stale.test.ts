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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nd = (...evs: unknown[]) => evs.map((e) => JSON.stringify(e) + "\n").join("");
type M = { line: number; col: number; len: number; preview: string; pcol: number };
const m = (line: number, preview: string, pcol: number, len: number): M => ({ line, col: pcol, len, preview, pcol });
const file = (path: string, matches: M[]) => ({ t: "file" as const, path, matches });
const done = () => ({ t: "done" as const, files: 2, matches: 2, skipped: 0, truncated: false as const, ms: 1 });
const RESULTS = nd(file("src/a.ts", [m(1, "needle", 0, 6)]), file("src/b.ts", [m(2, "needle", 0, 6)]), done());

describe("SearchView staleness (AC-22)", () => {
  beforeEach(() => {
    expect(S?.SearchView).toBeDefined();
  });
  let restore = () => {};
  afterEach(() => restore());

  const make = () => {
    const r = mockFetch(() => new Response(RESULTS));
    restore = r.restore;
    const v = new S.SearchView({ debounce: 0 }) as InstanceType<typeof S.SearchView> & {
      markStale(paths: string[], many?: boolean): void;
      onShown(): void;
    };
    const root = v.el as unknown as FakeElement;
    const input = root.querySelector(".sv-query")!;
    const bar = () => root.querySelector(".sv-stale");
    const visible = () => !!bar() && !bar()!.hidden && /out of date/i.test(bar()!.textContent);
    const refresh = () => root.querySelector(".sv-refresh");
    const flush = async () => {
      for (let i = 0; i < 5; i++) await sleep(0);
    };
    const search = async () => {
      input.value = "needle";
      input.dispatchEvent(new FakeEvent("input"));
      await flush();
    };
    return { v, r, root, bar, visible, refresh, flush, search };
  };

  test("no bar before a search has run, even when a path changes", () => {
    const t = make();
    t.v.markStale(["src/a.ts"]);
    expect(t.visible()).toBe(false);
  });

  test("a changed path that is in the results shows the Results may be out of date bar with a Refresh button", async () => {
    const t = make();
    await t.search();
    expect(t.visible()).toBe(false);
    t.v.markStale(["src/b.ts"]);
    expect(t.visible()).toBe(true);
    expect(t.bar()!.textContent).toContain("Results may be out of date");
    expect(t.refresh()).not.toBeNull();
    expect(t.refresh()!.textContent).toContain("Refresh");
  });

  test("a changed path that is not in the results leaves the bar hidden", async () => {
    const t = make();
    await t.search();
    t.v.markStale(["src/other.ts", "README.md"]);
    expect(t.visible()).toBe(false);
  });

  test("a many-changes event marks stale regardless of paths", async () => {
    const t = make();
    await t.search();
    t.v.markStale([], true);
    expect(t.visible()).toBe(true);
  });

  test("Refresh re-runs the current query and hides the bar", async () => {
    const t = make();
    await t.search();
    expect(t.r.calls.length).toBe(1);
    t.v.markStale(["src/a.ts"]);
    expect(t.visible()).toBe(true);
    t.refresh()!.dispatchEvent(new FakeEvent("click"));
    await t.flush();
    expect(t.r.calls.length).toBe(2);
    expect(new URL(t.r.calls[1]!.url, "http://x").searchParams.get("q")).toBe("needle");
    expect(t.visible()).toBe(false);
  });

  test("a new search clears the bar", async () => {
    const t = make();
    await t.search();
    t.v.markStale(["src/a.ts"]);
    expect(t.visible()).toBe(true);
    await t.search();
    expect(t.visible()).toBe(false);
  });

  test("while the view is hidden a change marks stale without searching, and showing it refreshes once", async () => {
    const t = make();
    await t.search();
    t.root.hidden = true;
    t.v.markStale(["src/a.ts"]);
    await t.flush();
    expect(t.r.calls.length).toBe(1);
    t.root.hidden = false;
    t.v.onShown();
    await t.flush();
    expect(t.r.calls.length).toBe(2);
    expect(t.visible()).toBe(false);
    t.v.onShown();
    await t.flush();
    expect(t.r.calls.length).toBe(2);
  });

  test("onShown without a pending change does not search", async () => {
    const t = make();
    await t.search();
    t.v.onShown();
    await t.flush();
    expect(t.r.calls.length).toBe(1);
  });
});

describe("SearchView when the stream ends without done (SL02 R-01)", () => {
  beforeEach(() => {
    expect(S?.SearchView).toBeDefined();
  });
  let restore = () => {};
  afterEach(() => restore());

  test("it leaves the searching state, hides the progress bar and ignores the missing done", async () => {
    const r = mockFetch(() => new Response(nd(file("src/a.ts", [m(1, "needle", 0, 6)]))));
    restore = r.restore;
    const v = new S.SearchView({ debounce: 0 });
    const root = v.el as unknown as FakeElement;
    const input = root.querySelector(".sv-query")!;
    input.value = "needle";
    input.dispatchEvent(new FakeEvent("input"));
    await sleep(250);
    expect(root.querySelector(".sv-progress")!.hidden).toBe(true);
    expect(root.querySelector(".sv-results")!.innerHTML).not.toContain("Searching");
    expect(root.querySelector(".sv-results")!.innerHTML).toContain("a.ts");
  });

  test("an empty stream ends in the no-results state, not searching", async () => {
    const r = mockFetch(() => new Response(""));
    restore = r.restore;
    const v = new S.SearchView({ debounce: 0 });
    const root = v.el as unknown as FakeElement;
    const input = root.querySelector(".sv-query")!;
    input.value = "needle";
    input.dispatchEvent(new FakeEvent("input"));
    await sleep(250);
    expect(root.querySelector(".sv-progress")!.hidden).toBe(true);
    expect(root.querySelector(".sv-results")!.innerHTML).not.toContain("Searching");
  });
});
