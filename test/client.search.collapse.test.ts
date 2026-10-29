import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let S: typeof import("../src/client/search.ts");
beforeAll(async () => {
  installDom();
  // Loaded dynamically so a missing module fails by assertion, not by a load error.
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
const done = () => ({ t: "done" as const, files: 3, matches: 5, skipped: 0, truncated: false as const, ms: 1 });

// flat indexes: a.ts = 0,1 (lines 1,2)   b.ts = 2,3 (lines 10,11)   c.ts = 4 (line 20)
const body = () =>
  new Response(
    nd(
      file("a.ts", [m(1, "foo", 0, 3), m(2, "foo", 0, 3)]),
      file("b.ts", [m(10, "foo", 0, 3), m(11, "foo", 0, 3)]),
      file("c.ts", [m(20, "foo", 0, 3)]),
      done(),
    ),
  );

describe("SearchView with collapsed groups", () => {
  beforeEach(() => {
    expect(S?.SearchView).toBeDefined();
  });
  let restore = () => {};
  afterEach(() => restore());

  const make = async () => {
    const r = mockFetch(body);
    restore = r.restore;
    const v = new S.SearchView({ debounce: 0 });
    const root = v.el as unknown as FakeElement;
    const input = root.querySelector(".sv-query")!;
    const results = root.querySelector(".sv-results")!;
    input.value = "foo";
    input.dispatchEvent(new FakeEvent("input"));
    for (let i = 0; i < 5; i++) await sleep(0);
    const opened: { path: string; line: number }[] = [];
    v.onOpen = (path, line) => opened.push({ path, line });
    const key = (k: string) => results.dispatchEvent(new FakeEvent("keydown", { key: k }));
    const toggleGroup = (f: number) =>
      results.dispatchEvent(new FakeEvent("click", { target: { closest: (sel: string) => (sel.includes("sv-file") ? { dataset: { f: String(f) } } : null) } }));
    const rendered = () => [...results.innerHTML.matchAll(/<div class="sv-row[^"]*"[^>]*data-i="(\d+)"/g)].map((x) => Number(x[1]));
    const selectedRows = () =>
      [...results.innerHTML.matchAll(/<div class="sv-row[^"]*"[^>]*>/g)].filter((t) => t[0].includes('aria-selected="true"')).map((t) => Number(/data-i="(\d+)"/.exec(t[0])![1]));
    return { v, opened, key, toggleGroup, rendered, selectedRows };
  };

  /** The invariant behind every rule: the selected row is rendered, and is the only selected one. */
  const consistent = (t: Awaited<ReturnType<typeof make>>) => {
    if (t.v.selected < 0) return expect(t.selectedRows()).toEqual([]);
    expect(t.rendered()).toContain(t.v.selected);
    expect(t.selectedRows()).toEqual([t.v.selected]);
  };

  test("Up/Down skip rows of collapsed groups", async () => {
    const t = await make();
    t.toggleGroup(1);
    expect(t.rendered()).toEqual([0, 1, 4]);
    t.key("ArrowDown");
    expect(t.v.selected).toBe(0);
    t.key("ArrowDown");
    expect(t.v.selected).toBe(1);
    t.key("ArrowDown");
    expect(t.v.selected).toBe(4);
    consistent(t);
    t.key("ArrowDown"); // end of the visible rows
    expect(t.v.selected).toBe(4);
    t.key("ArrowUp");
    expect(t.v.selected).toBe(1);
    consistent(t);
  });

  test("Down from nothing lands on the first visible row, Up on the last visible row", async () => {
    const t = await make();
    t.toggleGroup(0);
    t.key("ArrowDown");
    expect(t.v.selected).toBe(2);
    consistent(t);
    const u = await make();
    u.toggleGroup(2);
    u.key("ArrowUp");
    expect(u.v.selected).toBe(3);
    consistent(u);
  });

  test("move() follows the same visible-only rule", async () => {
    const t = await make();
    t.toggleGroup(1);
    t.v.move(1);
    t.v.move(1);
    t.v.move(1);
    expect(t.v.selected).toBe(4);
    expect(t.opened).toEqual([]);
  });

  test("Enter opens the selected visible row and never a hidden one", async () => {
    const t = await make();
    t.toggleGroup(1);
    for (let i = 0; i < 3; i++) t.key("ArrowDown");
    t.key("Enter");
    expect(t.opened).toEqual([{ path: "c.ts", line: 20 }]);
  });

  test("collapsing the group of the selection moves it to the nearest visible row", async () => {
    const t = await make();
    t.v.move(1);
    t.v.move(1);
    t.v.move(1); // row 2, in b.ts
    expect(t.v.selected).toBe(2);
    t.toggleGroup(1);
    expect(t.v.selected).toBe(1); // 1 is nearer than 4
    consistent(t);

    const u = await make();
    u.v.move(1); // row 0, in a.ts
    u.toggleGroup(0);
    expect(u.v.selected).toBe(2); // nothing before it, the next visible row
    consistent(u);

    const w = await make();
    for (let i = 0; i < 5; i++) w.v.move(1); // row 4, in c.ts
    w.toggleGroup(2);
    expect(w.v.selected).toBe(3);
    consistent(w);
  });

  test("collapsing a group that does not hold the selection keeps it", async () => {
    const t = await make();
    t.v.move(1);
    t.toggleGroup(2);
    expect(t.v.selected).toBe(0);
    consistent(t);
  });

  test("collapsing every group clears the selection, and Enter then opens nothing", async () => {
    const t = await make();
    t.v.move(1);
    t.v.move(1);
    t.toggleGroup(0);
    t.toggleGroup(1);
    t.toggleGroup(2);
    expect(t.rendered()).toEqual([]);
    expect(t.v.selected).toBe(-1);
    expect(t.selectedRows()).toEqual([]);
    t.key("Enter");
    t.key("ArrowDown");
    expect(t.v.selected).toBe(-1);
    expect(t.opened).toEqual([]);
  });

  test("expanding a group again keeps the selection and shows its rows", async () => {
    const t = await make();
    t.v.move(1);
    t.toggleGroup(1);
    t.toggleGroup(1);
    expect(t.rendered()).toEqual([0, 1, 2, 3, 4]);
    expect(t.v.selected).toBe(0);
  });

  test("F4 steps through all matches in order and expands a collapsed target group first", async () => {
    const t = await make();
    t.toggleGroup(1);
    expect(t.rendered()).toEqual([0, 1, 4]);
    expect(t.v.step(1)).toBe(true);
    expect(t.v.step(1)).toBe(true);
    expect(t.v.selected).toBe(1);
    expect(t.v.step(1)).toBe(true); // next match is b.ts:10, hidden until now
    expect(t.v.selected).toBe(2);
    expect(t.rendered()).toEqual([0, 1, 2, 3, 4]);
    consistent(t);
    expect(t.opened.at(-1)).toEqual({ path: "b.ts", line: 10 });
    expect(t.opened.map((o) => o.line)).toEqual([1, 2, 10]);
  });

  test("Shift+F4 goes backwards through hidden matches, wrapping, expanding each target", async () => {
    const t = await make();
    t.toggleGroup(2);
    t.toggleGroup(1);
    expect(t.v.step(-1)).toBe(true); // from nothing: the very last match, in collapsed c.ts
    expect(t.v.selected).toBe(4);
    expect(t.rendered()).toContain(4);
    consistent(t);
    expect(t.v.step(-1)).toBe(true); // b.ts:11, collapsed too
    expect(t.v.selected).toBe(3);
    expect(t.rendered()).toEqual([0, 1, 2, 3, 4]);
    consistent(t);
    expect(t.opened.map((o) => o.line)).toEqual([20, 11]);
  });

  test("F4 wrapping onto a collapsed first group expands it", async () => {
    const t = await make();
    for (let i = 0; i < 5; i++) t.v.step(1); // at the last match, row 4
    t.toggleGroup(0);
    expect(t.v.selected).toBe(4);
    expect(t.v.step(1)).toBe(true); // wraps to a.ts:1
    expect(t.v.selected).toBe(0);
    expect(t.rendered()).toContain(0);
    consistent(t);
    expect(t.opened.at(-1)).toEqual({ path: "a.ts", line: 1 });
  });

  test("F4 when the selection is in a group that was collapsed continues from the moved selection", async () => {
    const t = await make();
    t.v.move(1);
    t.v.move(1);
    t.v.move(1); // row 2
    t.toggleGroup(1); // selection moves to row 1
    expect(t.v.step(1)).toBe(true);
    expect(t.v.selected).toBe(2); // b.ts is expanded again
    expect(t.rendered()).toContain(2);
    consistent(t);
  });

  test("whatever is collapsed, onOpen only ever receives a rendered, selected row", async () => {
    const t = await make();
    const plan: (() => void)[] = [
      () => t.toggleGroup(0),
      () => t.v.step(1),
      () => t.toggleGroup(2),
      () => t.v.step(1),
      () => t.key("ArrowDown"),
      () => t.key("Enter"),
      () => t.toggleGroup(1),
      () => t.v.step(-1),
      () => t.toggleGroup(0),
      () => t.key("ArrowUp"),
      () => t.key("Enter"),
      () => t.v.step(1),
      () => t.toggleGroup(1),
      () => t.toggleGroup(2),
      () => t.key("Enter"),
      () => t.v.step(-1),
    ];
    const lines = new Map([[0, 1], [1, 2], [2, 10], [3, 11], [4, 20]]);
    for (const act of plan) {
      const before = t.opened.length;
      act();
      consistent(t);
      if (t.opened.length > before) {
        // the newest open belongs to the selected, rendered row
        expect(t.opened.at(-1)!.line).toBe(lines.get(t.v.selected)!);
      }
    }
  });
});
