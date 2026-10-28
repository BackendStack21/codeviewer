import { describe, expect, test } from "bun:test";
import { compileQuery, matchText } from "../src/server/search.ts";

function re(q: string, o = {}): RegExp {
  const c = compileQuery(q, o);
  if (!c.ok) throw new Error("compile failed: " + c.error);
  return c.re;
}

describe("compileQuery (AC-1)", () => {
  test("literal query is escaped", () => {
    const r = re("a.b");
    expect(r.test("a.b")).toBe(true);
    r.lastIndex = 0;
    expect(r.test("axb")).toBe(false);
  });
  test("flags: always g and u, i unless case-sensitive", () => {
    expect(re("x").flags.split("").sort().join("")).toBe("giu");
    expect(re("x", { case: true }).flags.split("").sort().join("")).toBe("gu");
    expect(re("x", { regex: true }).flags).toContain("g");
    expect(re("x", { regex: true }).flags).toContain("u");
  });
  test("case-insensitive matches other case, case-sensitive does not", () => {
    expect("ABC".match(re("abc"))).not.toBeNull();
    expect("ABC".match(re("abc", { case: true }))).toBeNull();
  });
  test("whole word uses the find-bar rule \\b(?:src)\\b", () => {
    const r = re("foo", { word: true });
    expect(r.source).toBe("\\b(?:foo)\\b");
    expect("foobar foo".match(r)?.length).toBe(1);
    const rr = re("a|b", { word: true, regex: true });
    expect(rr.source).toBe("\\b(?:a|b)\\b");
  });
  test("regex mode treats the query as a pattern", () => {
    expect("axb".match(re("a.b", { regex: true }))).not.toBeNull();
  });
});

describe("compileQuery errors (AC-4)", () => {
  const fixed = (c: ReturnType<typeof compileQuery>) => {
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(typeof c.error).toBe("string");
    expect(c.error.length).toBeGreaterThan(0);
    return c.error;
  };
  test("empty query", () => {
    expect(fixed(compileQuery(""))).toBeDefined();
  });
  test("over 256 UTF-16 units; exactly 256 is fine", () => {
    expect(fixed(compileQuery("a".repeat(257)))).toBeDefined();
    expect(compileQuery("a".repeat(256)).ok).toBe(true);
    // astral chars count as 2 units
    expect(compileQuery("😀".repeat(129)).ok).toBe(false);
  });
  test("control characters", () => {
    for (const q of ["a\x00b", "a\nb", "a\x1fb", "a\x7fb", "a\x85b"]) expect(fixed(compileQuery(q))).toBeDefined();
  });
  test("invalid regex returns a fixed string and does not throw", () => {
    const a = fixed(compileQuery("(", { regex: true }));
    const b = fixed(compileQuery("[a-", { regex: true }));
    expect(a).toBe(b!);
    expect(a).not.toContain("(");
  });
  test("invalid-regex-looking literal is fine without regex", () => {
    expect(compileQuery("(").ok).toBe(true);
  });
});

describe("matchText lines and columns (AC-2)", () => {
  test("line numbers agree with split on /\\r\\n|\\r|\\n/", () => {
    const text = "x\r\nfoo\rbar foo\nbaz\r\n\nfoo";
    const lines = text.split(/\r\n|\r|\n/);
    const { matches } = matchText(text, re("foo"));
    expect(matches.map((m) => m.line)).toEqual([2, 3, 6]);
    for (const m of matches) expect(lines[m.line - 1]!.slice(m.col, m.col + m.len)).toBe("foo");
    expect(matches.map((m) => m.col)).toEqual([0, 4, 0]);
  });
  test("cols are UTF-16 offsets", () => {
    const { matches } = matchText("😀😀 foo", re("foo"));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.col).toBe(5);
    expect(matches[0]!.len).toBe(3);
  });
  test("zero-length matches are dropped", () => {
    expect(matchText("abc", re("x*", { regex: true })).matches).toEqual([]);
    const { matches } = matchText("abxc", re("x*", { regex: true }));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.col).toBe(2);
  });
  test("multi-line match is clipped to its first line", () => {
    const { matches } = matchText("ab\ncd", re("b\\nc", { regex: true }));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ line: 1, col: 1, len: 1 });
  });
  test("multiple matches on one line, no match returns empty", () => {
    expect(matchText("aa a", re("a")).matches.map((m) => m.col)).toEqual([0, 1, 3]);
    expect(matchText("zzz", re("a"))).toEqual({ matches: [], more: 0 });
  });
});

describe("matchText caps and previews (AC-3)", () => {
  test("100 per file and `more` is the remainder", () => {
    const text = Array.from({ length: 130 }, () => "hit").join("\n");
    const r = matchText(text, re("hit"));
    expect(r.matches).toHaveLength(100);
    expect(r.more).toBe(30);
    expect(r.matches[99]!.line).toBe(100);
  });
  test("exactly 100 matches leaves more at 0", () => {
    const text = Array.from({ length: 100 }, () => "hit").join("\n");
    expect(matchText(text, re("hit"))).toMatchObject({ more: 0 });
  });
  test("short line: preview is the line, pcol is the col, no ellipsis", () => {
    const m = matchText("hello foo", re("foo")).matches[0]!;
    expect(m.preview).toBe("hello foo");
    expect(m.pcol).toBe(6);
  });
  test("long line: ellipsis ~30 chars before the match, ~200 chars, pcol points at match", () => {
    const line = "a".repeat(100) + "NEEDLE" + "b".repeat(300);
    const m = matchText(line, re("NEEDLE")).matches[0]!;
    expect(m.preview.startsWith("…")).toBe(true);
    expect(m.preview.length).toBeGreaterThanOrEqual(150);
    expect(m.preview.length).toBeLessThanOrEqual(210);
    expect(m.preview.slice(m.pcol, m.pcol + m.len)).toBe("NEEDLE");
    // about 30 chars of context precede the match (within the ellipsis)
    expect(m.pcol).toBeGreaterThanOrEqual(28);
    expect(m.pcol).toBeLessThanOrEqual(36);
    expect(m.col).toBe(100);
    expect(m.len).toBe(6);
  });
  test("match near the start of a long line has no leading ellipsis", () => {
    const line = "xx NEEDLE " + "b".repeat(400);
    const m = matchText(line, re("NEEDLE")).matches[0]!;
    expect(m.preview.startsWith("…")).toBe(false);
    expect(m.pcol).toBe(3);
    expect(m.preview.length).toBeLessThanOrEqual(210);
  });
});
