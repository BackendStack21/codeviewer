import { describe, expect, test } from "bun:test";
import { NavHistory, type NavLoc } from "../src/client/navhistory";

const L = (path: string, line: number): NavLoc => ({ path, line });

describe("NavHistory", () => {
  test("AC-1 first record on empty history", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 5));
    expect(h.entries()).toEqual([L("a", 5)]);
    expect(h.index()).toBe(0);
    expect(h.canBack()).toBe(false);
    expect(h.canForward()).toBe(false);
  });

  test("empty history has index -1 and no moves", () => {
    const h = new NavHistory();
    expect(h.index()).toBe(-1);
    expect(h.back()).toBeUndefined();
    expect(h.forward()).toBeUndefined();
    expect(h.entries()).toEqual([]);
  });

  test("AC-2 from appended as current when path differs, then to", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("b", 3), L("c", 9));
    expect(h.entries()).toEqual([L("a", 1), L("b", 3), L("c", 9)]);
    expect(h.index()).toBe(2);
  });

  test("AC-2 from updates the current entry when same path", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("a", 40), L("b", 2));
    expect(h.entries()).toEqual([L("a", 40), L("b", 2)]);
    expect(h.index()).toBe(1);
  });

  test("AC-2 record without from just appends to", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(undefined, L("b", 2));
    expect(h.entries()).toEqual([L("a", 1), L("b", 2)]);
  });

  test("AC-2 near boundary: 10 lines coalesces, 11 does not", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("a", 1), L("a", 11));
    expect(h.entries()).toEqual([L("a", 11)]);
    expect(h.index()).toBe(0);
    h.record(L("a", 11), L("a", 22));
    expect(h.entries()).toEqual([L("a", 11), L("a", 22)]);
    expect(h.index()).toBe(1);
  });

  test("AC-2 coalescing works backwards (negative delta)", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 50));
    h.record(L("a", 50), L("a", 40));
    expect(h.entries()).toEqual([L("a", 40)]);
    h.record(L("a", 40), L("a", 29));
    expect(h.entries()).toEqual([L("a", 40), L("a", 29)]);
  });

  test("AC-2 coalescing needs the same path", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("a", 1), L("b", 1));
    expect(h.entries()).toEqual([L("a", 1), L("b", 1)]);
  });

  test("AC-2 custom near", () => {
    const h = new NavHistory({ near: 2 });
    h.record(undefined, L("a", 1));
    h.record(L("a", 1), L("a", 3));
    expect(h.entries()).toEqual([L("a", 3)]);
    h.record(L("a", 3), L("a", 6));
    expect(h.entries()).toEqual([L("a", 3), L("a", 6)]);
  });

  test("AC-2 record discards entries after the current index", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("a", 1), L("b", 1));
    h.record(L("b", 1), L("c", 1));
    h.back(L("c", 1));
    h.back(L("b", 1));
    h.record(L("a", 1), L("d", 7));
    expect(h.entries()).toEqual([L("a", 1), L("d", 7)]);
    expect(h.canForward()).toBe(false);
  });

  test("AC-3 cap drops the oldest", () => {
    const h = new NavHistory({ cap: 3 });
    h.record(undefined, L("p0", 1));
    for (let i = 1; i < 5; i++) h.record(L(`p${i - 1}`, 1), L(`p${i}`, 1));
    expect(h.entries()).toEqual([L("p2", 1), L("p3", 1), L("p4", 1)]);
    expect(h.index()).toBe(2);
  });

  test("AC-3 default cap is 100", () => {
    const h = new NavHistory();
    h.record(undefined, L("p0", 1));
    for (let i = 1; i < 150; i++) h.record(L(`p${i - 1}`, 1), L(`p${i}`, 1));
    expect(h.entries().length).toBe(100);
    expect(h.entries()[0]).toEqual(L("p50", 1));
    expect(h.index()).toBe(99);
  });

  test("AC-4 back and forward move the index and return the entry", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("a", 1), L("b", 2));
    expect(h.canBack()).toBe(true);
    expect(h.back(L("b", 2))).toEqual(L("a", 1));
    expect(h.index()).toBe(0);
    expect(h.canBack()).toBe(false);
    expect(h.canForward()).toBe(true);
    expect(h.forward(L("a", 1))).toEqual(L("b", 2));
    expect(h.index()).toBe(1);
    expect(h.canForward()).toBe(false);
  });

  test("AC-4 back stores current into the current entry", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("a", 1), L("b", 2));
    h.back(L("b", 77));
    expect(h.entries()).toEqual([L("a", 1), L("b", 77)]);
    h.forward(L("a", 33));
    expect(h.entries()).toEqual([L("a", 33), L("b", 77)]);
  });

  test("AC-4 without current the entry is left alone", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("a", 1), L("b", 2));
    h.back();
    expect(h.entries()).toEqual([L("a", 1), L("b", 2)]);
  });

  test("AC-4 impossible moves return undefined and change nothing", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    expect(h.back(L("zzz", 9))).toBeUndefined();
    expect(h.forward(L("zzz", 9))).toBeUndefined();
    expect(h.entries()).toEqual([L("a", 1)]);
    expect(h.index()).toBe(0);
  });

  test("AC-5 back then record truncates forward", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("a", 1), L("b", 1));
    h.record(L("b", 1), L("c", 1));
    h.back(L("c", 1));
    expect(h.canForward()).toBe(true);
    h.record(L("b", 1), L("d", 1));
    expect(h.canForward()).toBe(false);
    expect(h.entries()).toEqual([L("a", 1), L("b", 1), L("d", 1)]);
    expect(h.index()).toBe(2);
  });

  test("AC-6 drop merges equal neighbours, index on merged entry", () => {
    const h = new NavHistory();
    h.record(undefined, L("a.ts", 1));
    h.record(L("a.ts", 1), L("b.ts", 5));
    h.record(L("b.ts", 5), L("a.ts", 1));
    expect(h.index()).toBe(2);
    h.drop("b.ts");
    expect(h.entries()).toEqual([L("a.ts", 1)]);
    expect(h.index()).toBe(0);
  });

  test("AC-6 index on the first of two merging entries lands on merged", () => {
    const h = new NavHistory();
    h.record(undefined, L("a.ts", 1));
    h.record(L("a.ts", 1), L("b.ts", 5));
    h.record(L("b.ts", 5), L("a.ts", 1));
    h.back(L("a.ts", 1));
    h.back(L("b.ts", 5));
    expect(h.index()).toBe(0);
    h.drop("b.ts");
    expect(h.entries()).toEqual([L("a.ts", 1)]);
    expect(h.index()).toBe(0);
  });

  test("AC-6 dropping the current entry moves to the nearest at or before", () => {
    const h = new NavHistory();
    h.record(undefined, L("a.ts", 1));
    h.record(L("a.ts", 1), L("b.ts", 5));
    h.record(L("b.ts", 5), L("c.ts", 9));
    h.back(L("c.ts", 9));
    expect(h.index()).toBe(1);
    h.drop("b.ts");
    expect(h.entries()).toEqual([L("a.ts", 1), L("c.ts", 9)]);
    expect(h.index()).toBe(0);
  });

  test("AC-6 dropping the current entry with none before goes to the first survivor", () => {
    const h = new NavHistory();
    h.record(undefined, L("a.ts", 1));
    h.record(L("a.ts", 1), L("b.ts", 5));
    h.back(L("b.ts", 5));
    expect(h.index()).toBe(0);
    h.drop("a.ts");
    expect(h.entries()).toEqual([L("b.ts", 5)]);
    expect(h.index()).toBe(0);
  });

  test("AC-6 index stays on the same surviving entry", () => {
    const h = new NavHistory();
    h.record(undefined, L("a.ts", 1));
    h.record(L("a.ts", 1), L("b.ts", 5));
    h.record(L("b.ts", 5), L("c.ts", 9));
    h.drop("a.ts");
    expect(h.entries()).toEqual([L("b.ts", 5), L("c.ts", 9)]);
    expect(h.index()).toBe(1);
  });

  test("AC-6 dropping the only path empties history", () => {
    const h = new NavHistory();
    h.record(undefined, L("a.ts", 1));
    h.record(L("a.ts", 1), L("a.ts", 50));
    h.drop("a.ts");
    expect(h.entries()).toEqual([]);
    expect(h.index()).toBe(-1);
    expect(h.canBack()).toBe(false);
    expect(h.canForward()).toBe(false);
  });

  test("AC-6 dropping an unknown path changes nothing", () => {
    const h = new NavHistory();
    h.record(undefined, L("a.ts", 1));
    h.drop("nope");
    expect(h.entries()).toEqual([L("a.ts", 1)]);
    expect(h.index()).toBe(0);
  });

  test("AC-7 returned objects are copies", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("a", 1), L("b", 2));
    const e = h.entries();
    e[0]!.line = 99;
    e.pop();
    expect(h.entries()).toEqual([L("a", 1), L("b", 2)]);
    const r = h.back(L("b", 2))!;
    r.line = 123;
    r.path = "x";
    expect(h.entries()).toEqual([L("a", 1), L("b", 2)]);
    const f = h.forward(L("a", 1))!;
    f.line = 5;
    expect(h.entries()).toEqual([L("a", 1), L("b", 2)]);
  });

  test("AC-7 inputs to record are copied", () => {
    const h = new NavHistory();
    const from = L("a", 1);
    const to = L("b", 2);
    h.record(undefined, from);
    h.record(from, to);
    from.line = 500;
    to.line = 600;
    to.path = "zzz";
    expect(h.entries()).toEqual([L("a", 1), L("b", 2)]);
  });

  test("AC-8 back then forward returns to where the user was", () => {
    const h = new NavHistory();
    h.record(undefined, L("a", 1));
    h.record(L("a", 1), L("b", 2));
    expect(h.back(L("b", 30))).toEqual(L("a", 1));
    expect(h.forward(L("a", 1))).toEqual(L("b", 30));
  });
});
