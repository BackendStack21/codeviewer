import { describe, expect, test } from "bun:test";
import { allRange, normalize, restorePlan, selectionText, type SelRange } from "../src/client/selection.ts";

const r = (sl: number, sc: number, el: number, ec: number): SelRange => ({ start: { line: sl, col: sc }, end: { line: el, col: ec } });
const lines = ["alpha", "\tbeta gamma", "", "delta"];

describe("normalize (AC-1)", () => {
  test("reversed endpoints are swapped", () => {
    expect(normalize(r(3, 2, 1, 4))).toEqual(r(1, 4, 3, 2));
  });
  test("same line reversed columns are swapped", () => {
    expect(normalize(r(2, 5, 2, 1))).toEqual(r(2, 1, 2, 5));
  });
  test("already ordered ranges are unchanged and the input is not mutated", () => {
    const a = r(0, 1, 2, 0);
    expect(normalize(a)).toEqual(r(0, 1, 2, 0));
    const b = r(3, 2, 1, 4);
    normalize(b);
    expect(b).toEqual(r(3, 2, 1, 4));
  });
});

describe("selectionText (AC-1)", () => {
  test("lines [a, \\tb, c] from (0,1) to (2,1)", () => {
    expect(selectionText(["a", "\tb", "c"], r(0, 1, 2, 1))).toBe("\n\tb\nc");
  });
  test("single line substring", () => {
    expect(selectionText(lines, r(0, 1, 0, 4))).toBe("lph");
  });
  test("partial first and last lines, tabs preserved", () => {
    expect(selectionText(lines, r(0, 2, 3, 3))).toBe("pha\n\tbeta gamma\n\ndel");
  });
  test("empty lines inside the range", () => {
    expect(selectionText(lines, r(1, 6, 3, 0))).toBe("gamma\n\n");
  });
  test("reversed (bottom-to-top) endpoints yield the same text", () => {
    expect(selectionText(lines, r(3, 3, 0, 2))).toBe("pha\n\tbeta gamma\n\ndel");
  });
  test("columns past the line end are clamped", () => {
    expect(selectionText(lines, r(0, 3, 0, 99))).toBe("ha");
  });
  test("collapsed range is empty", () => {
    expect(selectionText(lines, r(1, 2, 1, 2))).toBe("");
  });
  test("lines past the end of the file are ignored", () => {
    expect(selectionText(["a", "b"], r(1, 0, 9, 0))).toBe("b");
  });
});

describe("allRange (AC-6)", () => {
  test("covers first char to end of last line", () => {
    expect(allRange(lines)).toEqual(r(0, 0, 3, 5));
  });
  test("its text is the full file", () => {
    expect(selectionText(lines, allRange(lines))).toBe(lines.join("\n"));
  });
  test("single empty line", () => {
    expect(allRange([""])).toEqual(r(0, 0, 0, 0));
  });
});

describe("restorePlan (AC-4)", () => {
  const len = (n: number) => 10 + n;
  test("range inside the window maps to its own coordinates", () => {
    expect(restorePlan(r(12, 3, 15, 7), 10, 20, len)).toEqual({ anchor: { line: 12, offset: 3 }, focus: { line: 15, offset: 7 } });
  });
  test("start above the window clamps to the start of the first row", () => {
    expect(restorePlan(r(2, 4, 15, 7), 10, 20, len)).toEqual({ anchor: { line: 10, offset: 0 }, focus: { line: 15, offset: 7 } });
  });
  test("end below the window clamps to the end of the last row", () => {
    expect(restorePlan(r(12, 3, 99, 1), 10, 20, len)).toEqual({ anchor: { line: 12, offset: 3 }, focus: { line: 20, offset: 30 } });
  });
  test("range spanning the whole window clamps both ends", () => {
    expect(restorePlan(r(0, 0, 300, 5), 10, 20, len)).toEqual({ anchor: { line: 10, offset: 0 }, focus: { line: 20, offset: 30 } });
  });
  test("range entirely above or below the window is null", () => {
    expect(restorePlan(r(0, 0, 9, 5), 10, 20, len)).toBeNull();
    expect(restorePlan(r(21, 0, 30, 5), 10, 20, len)).toBeNull();
  });
  test("reversed range is normalised first", () => {
    expect(restorePlan(r(15, 7, 12, 3), 10, 20, len)).toEqual({ anchor: { line: 12, offset: 3 }, focus: { line: 15, offset: 7 } });
  });
  test("window edge lines are inclusive", () => {
    expect(restorePlan(r(10, 1, 20, 2), 10, 20, len)).toEqual({ anchor: { line: 10, offset: 1 }, focus: { line: 20, offset: 2 } });
  });
});

describe("truncated long lines (AC-3)", () => {
  test("selectionText returns the full model text, never a truncation label", () => {
    const long = "x".repeat(5000);
    const t = selectionText(["a", long, "b"], r(0, 0, 2, 1));
    expect(t).toBe("a\n" + long + "\nb");
    expect(t).not.toContain("more characters");
  });
});
