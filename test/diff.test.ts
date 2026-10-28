import { describe, expect, test } from "bun:test";
import { diffLines, gutterMarks, ADDED, MODIFIED, DELETED_BELOW, DELETED_ABOVE } from "../src/client/diff.ts";

/** Timing budgets are tuned on a laptop; shared CI runners get 4× headroom. */
const BUDGET = process.env.CI ? 4 : 1;

/** Applies hunks to `a`; must reproduce `b` exactly. */
function apply(a: string[], b: string[], hunks: ReturnType<typeof diffLines>): string[] {
  const out: string[] = [];
  let i = 0;
  for (const h of hunks) {
    out.push(...a.slice(i, h.a0), ...b.slice(h.b0, h.b1));
    i = h.a1;
  }
  return [...out, ...a.slice(i)];
}

describe("line diff", () => {
  test("identical", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([]);
  });

  test("insert, delete, modify", () => {
    const a = ["a", "b", "c", "d", "e"];
    const b = ["a", "B", "c", "e", "f"];
    const h = diffLines(a, b);
    expect(h).toEqual([
      { a0: 1, a1: 2, b0: 1, b1: 2 },
      { a0: 3, a1: 4, b0: 3, b1: 3 },
      { a0: 5, a1: 5, b0: 4, b1: 5 },
    ]);
    const marks = gutterMarks(h, b.length);
    expect(marks[1]).toBe(MODIFIED);
    expect(marks[2]! & DELETED_BELOW).toBeTruthy();
    expect(marks[4]).toBe(ADDED);
  });

  test("deletion at the very top", () => {
    const h = diffLines(["x", "a"], ["a"]);
    expect(gutterMarks(h, 1)[0]! & DELETED_ABOVE).toBeTruthy();
  });

  test("random edits always round-trip", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let t = 0; t < 300; t++) {
      const a = Array.from({ length: rnd(40) }, () => String.fromCharCode(97 + rnd(6)));
      const b = a.slice();
      for (let e = rnd(8); e > 0; e--) {
        const op = rnd(3);
        const at = rnd(b.length + 1);
        if (op === 0) b.splice(at, 0, String.fromCharCode(97 + rnd(6)));
        else if (op === 1 && b.length) b.splice(Math.min(at, b.length - 1), 1);
        else if (b.length) b[Math.min(at, b.length - 1)] = "Z";
      }
      const h = diffLines(a, b);
      expect(apply(a, b, h)).toEqual(b);
    }
  });

  test("large files stay fast", () => {
    const a = Array.from({ length: 100_000 }, (_, i) => `line ${i}`);
    const b = a.slice();
    for (let i = 0; i < 100_000; i += 997) b[i] = "changed";
    const t = performance.now();
    const h = diffLines(a, b);
    expect(performance.now() - t).toBeLessThan(500 * BUDGET);
    expect(apply(a, b, h)).toEqual(b);
  });
});
