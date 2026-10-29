import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, mockFetch, uninstallDom, type Dom, type FakeElement } from "./helpers/fakedom.ts";

let S: typeof import("../src/client/search.ts");
let K: typeof import("../src/client/keys.ts");
let C: typeof import("../src/client/codeview.ts");
let dom: Dom;
beforeAll(async () => {
  dom = installDom();
  // Loaded dynamically so a missing module or export fails by assertion, not by a load error.
  try {
    S = await import("../src/client/search.ts");
  } catch {}
  try {
    K = await import("../src/client/keys.ts");
  } catch {}
  try {
    C = await import("../src/client/codeview.ts");
  } catch {}
});
afterAll(() => uninstallDom());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nd = (...evs: unknown[]) => evs.map((e) => JSON.stringify(e) + "\n").join("");
type M = { line: number; col: number; len: number; preview: string; pcol: number };
const m = (line: number, preview: string, pcol: number, len: number, col = pcol): M => ({ line, col, len, preview, pcol });
const file = (path: string, matches: M[]) => ({ t: "file" as const, path, matches });
const done = () => ({ t: "done" as const, files: 2, matches: 3, skipped: 0, truncated: false as const, ms: 1 });

// ───────────────────────── markRanges ─────────────────────────

describe("markRanges", () => {
  beforeEach(() => {
    expect(typeof C?.markRanges).toBe("function");
  });
  const arr = (a: Uint8Array | null) => (a ? [...a] : null);

  test("no ranges, or an empty line, marks nothing", () => {
    expect(C.markRanges(10, [])).toBeNull();
    expect(C.markRanges(0, [{ start: 0, end: 3 }])).toBeNull();
  });
  test("a plain range is 1 over [start, end)", () => {
    expect(arr(C.markRanges(8, [{ start: 2, end: 5 }]))).toEqual([0, 0, 1, 1, 1, 0, 0, 0]);
  });
  test("the current match is 2", () => {
    expect(arr(C.markRanges(6, [{ start: 1, end: 3, cur: true }, { start: 4, end: 6 }]))).toEqual([0, 2, 2, 0, 1, 1]);
  });
  test("the current match wins over an overlapping match whatever the order", () => {
    const a = [{ start: 0, end: 4, cur: true }, { start: 2, end: 6 }];
    const exp = [2, 2, 2, 2, 1, 1];
    expect(arr(C.markRanges(6, a))).toEqual(exp);
    expect(arr(C.markRanges(6, [...a].reverse()))).toEqual(exp);
  });
  test("ranges are clamped to the line", () => {
    expect(arr(C.markRanges(4, [{ start: 2, end: 99 }]))).toEqual([0, 0, 1, 1]);
    expect(arr(C.markRanges(4, [{ start: -5, end: 2 }]))).toEqual([1, 1, 0, 0]);
  });
  test("empty, inverted and out-of-line ranges mark nothing", () => {
    expect(C.markRanges(4, [{ start: 2, end: 2 }])).toBeNull();
    expect(C.markRanges(4, [{ start: 3, end: 1 }])).toBeNull();
    expect(C.markRanges(4, [{ start: 4, end: 9 }])).toBeNull();
    expect(arr(C.markRanges(4, [{ start: 9, end: 12 }, { start: 0, end: 1 }]))).toEqual([1, 0, 0, 0]);
  });
});

describe("revealCol", () => {
  beforeEach(() => {
    expect(typeof C?.revealCol).toBe("function");
  });
  // viewport 800 wide, gutter 50, 10 px per column
  test("a column already in view keeps the scroll position", () => {
    expect(C.revealCol(0, 800, 50, 10, 5)).toBe(0);
    expect(C.revealCol(100, 800, 50, 10, 30)).toBe(100);
  });
  test("a column right of the view is centered", () => {
    expect(C.revealCol(0, 800, 50, 10, 100)).toBe(50 + 1000 - 400);
  });
  test("a column left of the view is centered, never below zero", () => {
    expect(C.revealCol(700, 800, 50, 10, 5)).toBe(0);
    expect(C.revealCol(2000, 800, 50, 10, 120)).toBe(50 + 1200 - 400);
  });
  test("columns past MAX_RENDER_COLS are clamped to it", () => {
    expect(C.revealCol(0, 800, 50, 10, 10_000)).toBe(C.revealCol(0, 800, 50, 10, 4000));
    expect(C.revealCol(0, 800, 50, 10, 10_000)).toBe(50 + 40_000 - 400);
  });
});

// ───────────────────────── key routing ─────────────────────────

describe("searchKey", () => {
  beforeEach(() => {
    expect(typeof K?.searchKey).toBe("function");
  });
  const mac = { isMac: true, inTerm: false };
  const pc = { isMac: false, inTerm: false };
  const term = (o: { isMac: boolean }) => ({ ...o, inTerm: true });

  test("Cmd+Shift+F (mac) and Ctrl+Shift+F (others) open search, from the terminal too", () => {
    expect(K.searchKey({ key: "F", metaKey: true, shiftKey: true }, mac)).toBe("search");
    expect(K.searchKey({ key: "f", metaKey: true, shiftKey: true }, term(mac))).toBe("search");
    expect(K.searchKey({ key: "F", ctrlKey: true, shiftKey: true }, pc)).toBe("search");
    expect(K.searchKey({ key: "F", ctrlKey: true, shiftKey: true }, term(pc))).toBe("search");
  });
  test("the wrong modifier for the platform does nothing", () => {
    expect(K.searchKey({ key: "F", ctrlKey: true, shiftKey: true }, mac)).toBeNull();
    expect(K.searchKey({ key: "F", metaKey: true, shiftKey: true }, pc)).toBeNull();
  });
  test("plain Cmd/Ctrl+F is the find bar, but not from the terminal", () => {
    expect(K.searchKey({ key: "f", metaKey: true }, mac)).toBe("find");
    expect(K.searchKey({ key: "f", ctrlKey: true }, pc)).toBe("find");
    expect(K.searchKey({ key: "f", metaKey: true }, term(mac))).toBeNull();
    expect(K.searchKey({ key: "f", ctrlKey: true }, term(pc))).toBeNull();
  });
  test("Shift never yields the find bar", () => {
    for (const o of [mac, pc, term(mac), term(pc)]) {
      const e = o.isMac ? { key: "F", metaKey: true, shiftKey: true } : { key: "F", ctrlKey: true, shiftKey: true };
      expect(K.searchKey(e, o)).not.toBe("find");
    }
  });
  test("F4 and Shift+F4 step results except in the terminal", () => {
    expect(K.searchKey({ key: "F4" }, pc)).toBe("next");
    expect(K.searchKey({ key: "F4", shiftKey: true }, pc)).toBe("prev");
    expect(K.searchKey({ key: "F4" }, mac)).toBe("next");
    expect(K.searchKey({ key: "F4" }, term(pc))).toBeNull();
    expect(K.searchKey({ key: "F4", shiftKey: true }, term(mac))).toBeNull();
  });
  test("F4 with Alt/Ctrl/Cmd (window and tab close shortcuts) is left alone", () => {
    expect(K.searchKey({ key: "F4", altKey: true }, pc)).toBeNull();
    expect(K.searchKey({ key: "F4", ctrlKey: true }, pc)).toBeNull();
    expect(K.searchKey({ key: "F4", metaKey: true }, mac)).toBeNull();
  });
  test("other keys do nothing", () => {
    expect(K.searchKey({ key: "g", metaKey: true }, mac)).toBeNull();
    expect(K.searchKey({ key: "F5" }, pc)).toBeNull();
    expect(K.searchKey({ key: "f" }, pc)).toBeNull();
    expect(K.searchKey({ key: "p", metaKey: true, shiftKey: true }, mac)).toBeNull();
  });
});

describe("normSideView", () => {
  beforeEach(() => {
    expect(typeof K?.normSideView).toBe("function");
  });
  test("keeps the two known views and falls back to the Explorer", () => {
    expect(K.normSideView("search")).toBe("search");
    expect(K.normSideView("explorer")).toBe("explorer");
    for (const v of [undefined, null, "", "git", 3, {}, "Search"]) expect(K.normSideView(v)).toBe("explorer");
  });
});

// ───────────────────────── SearchView navigation ─────────────────────────

describe("SearchView navigation", () => {
  beforeEach(() => {
    expect(S?.SearchView).toBeDefined();
  });
  let restore = () => {};
  afterEach(() => restore());

  const make = (handler: Parameters<typeof mockFetch>[0]) => {
    const r = mockFetch(handler);
    restore = r.restore;
    const v = new S.SearchView({ debounce: 0 });
    const root = v.el as unknown as FakeElement;
    const must = (sel: string): FakeElement => {
      const e = root.querySelector(sel);
      expect(e).not.toBeNull();
      return e!;
    };
    const input = must(".sv-query");
    const results = must(".sv-results");
    const toggle = (opt: string) => root.querySelectorAll(".sv-toggle").find((e) => e.dataset.opt === opt)!;
    const type = (s: string) => {
      input.value = s;
      input.dispatchEvent(new FakeEvent("input"));
    };
    const key = (el: FakeElement, k: string, extra: Record<string, unknown> = {}) => {
      const e = new FakeEvent("keydown", { key: k, ...extra });
      el.dispatchEvent(e);
      return e;
    };
    const flush = async () => {
      for (let i = 0; i < 5; i++) await sleep(0);
    };
    const opened: unknown[][] = [];
    v.onOpen = (...a) => opened.push(a);
    /** data-i of every row rendered as selected. */
    const selectedRows = () =>
      [...results.innerHTML.matchAll(/<div class="sv-row[^"]*"[^>]*>/g)].filter((t) => t[0].includes('aria-selected="true"')).map((t) => Number(/data-i="(\d+)"/.exec(t[0])![1]));
    return { v, r, input, results, toggle, type, key, flush, opened, selectedRows };
  };

  const three = () =>
    new Response(nd(file("src/a.ts", [m(3, "foo bar", 0, 3), m(9, "a foo", 2, 3)]), file("lib/b.ts", [m(12, "xx foo", 3, 3, 40)]), done()));

  const loaded = async () => {
    const t = make(three);
    t.type("foo");
    await t.flush();
    return t;
  };

  test("toggle titles match the find bar", () => {
    const t = make(three);
    expect(t.toggle("case").title).toBe("Match case");
    expect(t.toggle("word").title).toBe("Whole word");
    expect(t.toggle("regex").title).toBe("Regular expression");
  });

  test("the results list is focusable", () => {
    const t = make(three);
    expect(t.results.getAttribute("tabindex")).toBe("0");
  });

  test("starts with no selection", async () => {
    const t = await loaded();
    expect(t.v.selected).toBe(-1);
    expect(t.selectedRows()).toEqual([]);
  });

  test("Down/Up in the list move the selection and mark exactly that row", async () => {
    const t = await loaded();
    const e = t.key(t.results, "ArrowDown");
    expect(e.defaultPrevented).toBe(true);
    expect(t.v.selected).toBe(0);
    expect(t.selectedRows()).toEqual([0]);
    t.key(t.results, "ArrowDown");
    t.key(t.results, "ArrowDown");
    expect(t.v.selected).toBe(2);
    expect(t.selectedRows()).toEqual([2]);
    t.key(t.results, "ArrowUp");
    expect(t.v.selected).toBe(1);
    expect(t.selectedRows()).toEqual([1]);
  });

  test("the selection stops at both ends", async () => {
    const t = await loaded();
    for (let i = 0; i < 6; i++) t.key(t.results, "ArrowDown");
    expect(t.v.selected).toBe(2);
    for (let i = 0; i < 6; i++) t.key(t.results, "ArrowUp");
    expect(t.v.selected).toBe(0);
  });

  test("move() selects without opening", async () => {
    const t = await loaded();
    t.v.move(1);
    t.v.move(1);
    expect(t.v.selected).toBe(1);
    expect(t.opened).toEqual([]);
  });

  test("Enter opens the selected result and keeps focus in the list", async () => {
    const t = await loaded();
    t.results.focus();
    t.key(t.results, "ArrowDown");
    t.key(t.results, "ArrowDown");
    t.key(t.results, "ArrowDown");
    const e = t.key(t.results, "Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(t.opened).toEqual([["lib/b.ts", 12, 40, 3]]);
    expect(dom.document.activeElement).toBe(t.results);
  });

  test("Enter with nothing selected opens nothing", async () => {
    const t = await loaded();
    t.key(t.results, "Enter");
    expect(t.opened).toEqual([]);
  });

  test("Esc in the list returns to the query", async () => {
    const t = await loaded();
    t.results.focus();
    t.key(t.results, "ArrowDown");
    const e = t.key(t.results, "Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(dom.document.activeElement).toBe(t.input);
    expect(t.results.innerHTML).toContain("sv-row"); // results are kept
  });

  test("Esc in the query clears it, aborts the search and restores the hint", async () => {
    let sig!: AbortSignal;
    const t = make((_u, init) => {
      sig = init!.signal as AbortSignal;
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/x-ndjson" } });
    });
    t.type("foo");
    await t.flush();
    expect(sig.aborted).toBe(false);
    const e = t.key(t.input, "Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(t.input.value).toBe("");
    expect(sig.aborted).toBe(true);
    expect(t.results.innerHTML).toContain("Type to search");
    expect(t.v.selected).toBe(-1);
  });

  test("a new search drops the selection", async () => {
    const t = await loaded();
    t.key(t.results, "ArrowDown");
    expect(t.v.selected).toBe(0);
    t.type("foob");
    expect(t.v.selected).toBe(-1);
    await t.flush();
    expect(t.selectedRows()).toEqual([]);
  });

  test("step() selects and opens results in order, wrapping around", async () => {
    const t = await loaded();
    expect(t.v.step(1)).toBe(true);
    expect(t.v.selected).toBe(0);
    expect(t.v.step(1)).toBe(true);
    expect(t.v.step(1)).toBe(true);
    expect(t.v.selected).toBe(2);
    expect(t.v.step(1)).toBe(true); // wraps to the first
    expect(t.v.selected).toBe(0);
    expect(t.opened).toEqual([
      ["src/a.ts", 3, 0, 3],
      ["src/a.ts", 9, 2, 3],
      ["lib/b.ts", 12, 40, 3],
      ["src/a.ts", 3, 0, 3],
    ]);
    expect(t.selectedRows()).toEqual([0]);
  });

  test("step(-1) starts from the last result and wraps from the first", async () => {
    const t = await loaded();
    expect(t.v.step(-1)).toBe(true);
    expect(t.v.selected).toBe(2);
    t.v.move(-1);
    t.v.move(-1);
    expect(t.v.selected).toBe(0);
    expect(t.v.step(-1)).toBe(true);
    expect(t.v.selected).toBe(2);
    expect(t.opened.at(-1)).toEqual(["lib/b.ts", 12, 40, 3]);
  });

  test("step() with no results does nothing", () => {
    const t = make(three);
    expect(t.v.step(1)).toBe(false);
    expect(t.v.step(-1)).toBe(false);
    expect(t.opened).toEqual([]);
    expect(t.v.selected).toBe(-1);
  });

  test("dropping below the eligibility threshold aborts and clears the results", async () => {
    let sig!: AbortSignal;
    const t = make((_u, init) => {
      sig = init!.signal as AbortSignal;
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/x-ndjson" } });
    });
    t.type("ab");
    await t.flush();
    expect(t.r.calls.length).toBe(1);
    expect(sig.aborted).toBe(false);
    t.type("a");
    expect(sig.aborted).toBe(true);
    expect(t.results.innerHTML).toContain("Type to search");
    await t.flush();
    expect(t.r.calls.length).toBe(1); // a single character does not search
  });

  test("finished results are cleared too when the query drops below the threshold", async () => {
    const t = await loaded();
    expect(t.results.innerHTML).toContain("3 results in 2 files");
    t.type("f");
    expect(t.results.innerHTML).not.toContain("sv-row");
    expect(t.results.innerHTML).toContain("Type to search");
    expect(t.v.selected).toBe(-1);
  });

  test("in regex mode one character is still eligible and keeps searching", async () => {
    const t = make(three);
    t.toggle("regex").dispatchEvent(new FakeEvent("click"));
    t.type("f");
    await t.flush();
    expect(t.r.calls.length).toBe(1);
    expect(t.results.innerHTML).toContain("sv-row");
  });
});
