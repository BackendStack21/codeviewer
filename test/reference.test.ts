import { describe, expect, test } from "bun:test";
import { lineSpan, parseTarget, reference, referenceWithCode } from "../src/client/reference.ts";

const sel = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, col: c1 }, end: { line: l2, col: c2 } });

describe("lineSpan", () => {
  test("no selection: the active line; nothing at all: null", () => {
    expect(lineSpan(null, 4)).toEqual({ from: 5, to: 5 });
    expect(lineSpan(null, -1)).toBeNull();
    expect(lineSpan(sel(2, 3, 2, 3), 7)).toEqual({ from: 8, to: 8 }); // a caret is not a selection
  });
  test("a selection covers its lines; an end at column 0 of a later line leaves that line out", () => {
    expect(lineSpan(sel(1, 2, 3, 5), 0)).toEqual({ from: 2, to: 4 });
    expect(lineSpan(sel(1, 0, 4, 0), 0)).toEqual({ from: 2, to: 4 });
    expect(lineSpan(sel(1, 0, 1, 6), 9)).toEqual({ from: 2, to: 2 });
  });
});

describe("reference", () => {
  test("path, path:line and path:from-to", () => {
    expect(reference("src/a.ts", null)).toBe("src/a.ts");
    expect(reference("src/a.ts", { from: 12, to: 12 })).toBe("src/a.ts:12");
    expect(reference("src/a.ts", { from: 12, to: 40 })).toBe("src/a.ts:12-40");
  });
  test("with code: whole lines in a fence tagged with the extension", () => {
    const lines = ["a", "b", "c", "d"];
    expect(referenceWithCode("x/y.ts", { from: 2, to: 3 }, lines)).toBe("x/y.ts:2-3\n```ts\nb\nc\n```\n");
    expect(referenceWithCode("Makefile", { from: 1, to: 1 }, lines)).toBe("Makefile:1\n```\na\n```\n");
  });
  test("the fence is longer than any backtick run in the code", () => {
    const out = referenceWithCode("r.md", { from: 1, to: 1 }, ["````js"]);
    expect(out).toBe("r.md:1\n`````md\n````js\n`````\n");
  });
});

describe("parseTarget (terminal ⌘-click and codeviewer open)", () => {
  test("round-trips every reference form", () => {
    expect(parseTarget("src/a.ts")).toEqual({ path: "src/a.ts", line: 0 });
    expect(parseTarget("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12 });
    expect(parseTarget("src/a.ts:12:5")).toEqual({ path: "src/a.ts", line: 12 });
    expect(parseTarget(reference("src/a.ts", { from: 12, to: 40 }))).toEqual({ path: "src/a.ts", line: 12 });
  });
});

describe("unsafePath", () => {
  test("file names with control or bidi characters are refused; ordinary ones are fine", async () => {
    const { unsafePath } = await import("../src/client/reference.ts");
    expect(unsafePath("src/a b.ts")).toBe(false);
    expect(unsafePath("src/ünï.ts")).toBe(false);
    expect(unsafePath("x\nrm -rf ~")).toBe(true);
    expect(unsafePath("x\x1b[201~")).toBe(true);
    expect(unsafePath("x\u0085y")).toBe(true);
    expect(unsafePath("evil‮txt.sh")).toBe(true);
  });
});
