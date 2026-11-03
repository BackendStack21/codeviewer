import { expect, test } from "bun:test";
import { LANG_IDS, lexLine } from "../src/client/highlight.ts";
import { headingText, SYMBOL_LANGS, symbols } from "../src/client/symbols.ts";
import { parseMarkdown, slugify } from "../src/client/markdown.ts";

// Untrusted files must never freeze the UI thread. Every highlighter language, every Go to Symbol
// language and the Markdown parser run against pathological input: runs of each special character,
// alternations, long whitespace, and the shapes that were slow before. A new regex that backtracks
// (quadratic or worse) in any of them fails here, including languages added later (LANG_IDS).
//
// Timing without flakiness: candidates are screened at a small size, then the slowest are timed at
// two sizes 8× apart. Linear code grows ~8×, quadratic ~64×; the bound is 24× (and only once the
// large run takes long enough to measure).

const CHARS = [..." \t/\\*\"'`<>[](){}#-=:;.,$@!%&|^~?+_a0é😀"];
function inputs(n: number): string[] {
  const out: string[] = [];
  for (const c of CHARS) {
    out.push(
      c.repeat(n),
      (c + " ").repeat(n / 2),
      (c + "a").repeat(n / 2),
      "a".repeat(n / 2) + c.repeat(n / 2),
      c + " ".repeat(n - 1),
      " ".repeat(n - 1) + c,
      ("a" + c + c).repeat(n / 3),
    );
  }
  // Shapes that were super-linear once (DESIGN.md §24).
  out.push(
    "a".repeat(n / 2) + " /".repeat(n / 4),
    "public " + " ".repeat(n),
    "[" + " ".repeat(n),
    "# a" + " ".repeat(n) + "b",
    "http://a" + ")".repeat(n),
    "- ".repeat(n / 2) + "x:",
    "  ".repeat(n / 2) + "x",
    "[".repeat(n),
    "![a](".repeat(n / 5),
    // Multi-character openers that start a scan for their closer (DESIGN.md §24, third pass).
    "(/[".repeat(n / 3),
    "${".repeat(n / 2),
    "$(".repeat(n / 2),
    "[(".repeat(n / 2),
    "<!--".repeat(n / 4),
    "/*".repeat(n / 2),
    "'\"`".repeat(n / 3),
    "x = /".repeat(n / 5),
  );
  return out.map((s) => s.slice(0, n));
}

const best = (f: () => void, reps = 3) => {
  let t = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    f();
    t = Math.min(t, performance.now() - t0);
  }
  return t;
};

/** Screens every case at `small`, then checks the slowest `top` grow at most 24× from n to 8n. */
function expectLinear(cases: { name: string; run: (input: string) => void }[], small: number, n: number, top = 15) {
  const s = inputs(small);
  const timed: { name: string; run: (input: string) => void; i: number; t: number }[] = [];
  for (const c of cases) for (let i = 0; i < s.length; i++) timed.push({ ...c, i, t: best(() => c.run(s[i]!), 1) });
  timed.sort((a, b) => b.t - a.t);
  const a = inputs(n);
  const b = inputs(n * 8);
  const slow: string[] = [];
  for (const c of timed.slice(0, top)) {
    const ta = best(() => c.run(a[c.i]!));
    const tb = best(() => c.run(b[c.i]!));
    if (tb > 15 && tb / Math.max(ta, 0.05) > 24) slow.push(`${c.name} input #${c.i} ${JSON.stringify(b[c.i]!.slice(0, 12))}…: ${ta.toFixed(1)} ms → ${tb.toFixed(1)} ms`);
    // Whatever the growth, a single line must never take seconds.
    if (tb > 1000) slow.push(`${c.name} input #${c.i}: ${tb.toFixed(0)} ms at ${n * 8} chars`);
  }
  expect(slow).toEqual([]);
}

test("every highlighter language lexes pathological lines in linear time (also continuing a line's state)", () => {
  expect(LANG_IDS.length).toBeGreaterThanOrEqual(20);
  expectLinear(
    LANG_IDS.map((id) => ({
      name: `lexLine(${id})`,
      run: (s: string) => {
        lexLine(id, s, lexLine(id, s, 0, []), []);
      },
    })),
    1000,
    2000,
  );
}, 60_000);

test("Go to Symbol stays fast on long pathological lines in every language", () => {
  // Lines are capped at 1000 characters there, so this bounds work per line × lines.
  const lines = inputs(1000);
  const slow: string[] = [];
  for (const lang of [...SYMBOL_LANGS, "md"]) {
    const t = best(() => symbols(lang, lines), 2);
    if (t > 400) slow.push(`symbols(${lang}): ${t.toFixed(0)} ms for ${lines.length} lines`);
  }
  expect(slow).toEqual([]);
  expect(SYMBOL_LANGS.length).toBeGreaterThanOrEqual(15);
}, 60_000);

test("the Markdown parser, heading text and slugs grow linearly on pathological documents", () => {
  expectLinear(
    [
      { name: "parseMarkdown", run: (s: string) => void parseMarkdown(s) },
      { name: "parseMarkdown(lines)", run: (s: string) => void parseMarkdown(s.replace(/(.{40})/g, "$1\n")) },
      { name: "headingText", run: (s: string) => void headingText(s) },
      { name: "slugify", run: (s: string) => void slugify(s) },
    ],
    2000,
    4000,
  );
}, 60_000);

test("stripLinks is exactly the link regex it replaced (random strings over the link alphabet)", async () => {
  const { stripLinks } = await import("../src/client/symbols.ts");
  const old = (s: string) => s.replace(/!?\[([^\][]*)\]\([^)]*\)/g, "$1");
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const alphabet = ["!", "[", "]", "(", ")", "a", " ", "!["];
  for (let k = 0; k < 20_000; k++) {
    let s = "";
    const len = Math.floor(rand() * 24);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
    if (stripLinks(s) !== old(s)) throw new Error(`differs on ${JSON.stringify(s)}: ${JSON.stringify(stripLinks(s))} vs ${JSON.stringify(old(s))}`);
  }
  for (const s of ["see [the docs](x.md) now", "![img](a.png) and [b](c)", "[a](b(c)d)", "[[a](b)", "[a]](b)", "![a]![b](c)", "x![", "](", "[a]( b ) [c](d"]) {
    expect(stripLinks(s)).toBe(old(s));
  }
});
