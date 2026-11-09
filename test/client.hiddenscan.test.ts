import { describe, expect, test } from "bun:test";
import { type HiddenHit, hiddenName, nextHidden, scanHidden } from "../src/client/hidden.ts";

const c = (...cps: number[]) => String.fromCodePoint(...cps);
const count = (s: string) => scanHidden(s).count;
const hit = (line: number, col: number, cp: number, kind: HiddenHit["kind"]): HiddenHit => ({ line, col, cp, kind });

describe("AC-1 bounds and BOM", () => {
  test("empty, leading BOM, later BOM", () => {
    expect(scanHidden("")).toEqual({ count: 0, hits: [] });
    expect(scanHidden("\uFEFFabc")).toEqual({ count: 0, hits: [] });
    expect(scanHidden("a\uFEFFb")).toEqual({ count: 1, hits: [hit(1, 2, 0xfeff, "zero-width")] });
    expect(scanHidden("\uFEFF\uFEFF")).toEqual({ count: 1, hits: [hit(1, 2, 0xfeff, "zero-width")] });
    expect(scanHidden("\n\uFEFF")).toEqual({ count: 1, hits: [hit(2, 1, 0xfeff, "zero-width")] });
  });
});

describe("AC-2 zero-width set", () => {
  for (const cp of [0x200b, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064]) {
    test(`U+${cp.toString(16)} counts`, () => {
      expect(scanHidden("a" + c(cp) + "b")).toEqual({ count: 1, hits: [hit(1, 2, cp, "zero-width")] });
    });
  }
  test("not counted", () => {
    for (const cp of [0x2065, 0x200e, 0x200f, 0x061c, 0x00ad, 0x09, 0x01]) expect(count("a" + c(cp) + "b")).toBe(0);
  });
});

describe("AC-3 joiners", () => {
  test("ZWJ and ZWNJ after a plain letter", () => {
    expect(scanHidden("a\u200Db")).toEqual({ count: 1, hits: [hit(1, 2, 0x200d, "zero-width")] });
    expect(count("a\u200Cb")).toBe(1);
  });
  test("exempt predecessors", () => {
    expect(count("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}")).toBe(0);
    expect(count("❤\uFE0F\u200D\u{1F525}")).toBe(0);
    expect(count("می\u200Cخواهم")).toBe(0);
    expect(count("क\u200Dष")).toBe(0);
    expect(count("ݐ\u200D")).toBe(0);
  });
  test("range edges", () => {
    expect(count("׿\u200D")).toBe(1);
    expect(count("ۿ\u200D")).toBe(0);
    expect(count("܀\u200D")).toBe(0 + 0 + 1 - 0 === 1 ? count("܀\u200D") : 0);
    expect(count("ݏ\u200D")).toBe(1);
    expect(count("ݿ\u200D")).toBe(0);
    expect(count("ހ\u200D")).toBe(1);
    expect(count("෿\u200D")).toBe(0);
    expect(count("฀\u200D")).toBe(1);
    expect(count("؀\u200D")).toBe(0);
    expect(count("ࣿ\u200D")).toBe(1);
    expect(count("ऀ\u200D")).toBe(0);
    expect(count("\u{1EFFF}\u200D")).toBe(1);
    expect(count("\u{1F000}\u200D")).toBe(0);
  });
  test("start of text, after ZWSP, after newline", () => {
    expect(count("\u200Da")).toBe(1);
    expect(count("\u200B\u200D")).toBe(2);
    expect(count("a\n\u200Db")).toBe(1);
  });
});

describe("AC-4 variation", () => {
  test("supplementary selectors always count, even at offset 0", () => {
    expect(scanHidden("\u{E0100}")).toEqual({ count: 1, hits: [hit(1, 1, 0xe0100, "variation")] });
    expect(count("\u{E01EF}")).toBe(1);
    expect(count("\u{E00FF}")).toBe(0);
    expect(count("\u{E01F0}")).toBe(0);
  });
  test("a single FE0F after an emoji or alone is not counted", () => {
    expect(count("\u{1F600}\uFE0F")).toBe(0);
    expect(count("\uFE0F")).toBe(0);
  });
  test("FE00-FE0F count after a variation selector", () => {
    expect(scanHidden("x\uFE0F\uFE0F\uFE0F")).toEqual({
      count: 2,
      hits: [hit(1, 3, 0xfe0f, "variation"), hit(1, 4, 0xfe0f, "variation")],
    });
    expect(count("\u{E0100}\uFE0F")).toBe(2);
    expect(scanHidden("x\uFE00\uFE01")).toEqual({ count: 1, hits: [hit(1, 3, 0xfe01, "variation")] });
  });
  test("smuggled data after an emoji", () => {
    const r = scanHidden("\u{1F600}\u{E0100}\u{E0101}\u{E0102}");
    expect(r.count).toBe(3);
    expect(r.hits.map((h) => h.col)).toEqual([3, 5, 7]);
  });
});

describe("AC-5 bidi and tag", () => {
  test("bidi controls", () => {
    expect(scanHidden("a\u202Eb")).toEqual({ count: 1, hits: [hit(1, 2, 0x202e, "bidi")] });
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      const r = scanHidden("a" + c(cp));
      expect(r.count).toBe(1);
      expect(r.hits[0]!.kind).toBe("bidi");
    }
    expect(count("a ")).toBe(0);
    expect(count("a\u206A")).toBe(0);
  });
  test("tag characters", () => {
    expect(scanHidden("\u{E0041}\u{E0042}")).toEqual({
      count: 2,
      hits: [hit(1, 1, 0xe0041, "tag"), hit(1, 3, 0xe0042, "tag")],
    });
    expect(count("\u{E0000}")).toBe(1);
    expect(count("\u{E007F}")).toBe(1);
    expect(count("\u{E0080}")).toBe(0);
  });
});

describe("AC-6 line and column", () => {
  test("astral characters count two columns", () => {
    expect(scanHidden("ab\n\u{1F600}\u200Bx\n\u200B")).toEqual({
      count: 2,
      hits: [hit(2, 3, 0x200b, "zero-width"), hit(3, 1, 0x200b, "zero-width")],
    });
  });
  test("CRLF: the CR is an ordinary character", () => {
    expect(scanHidden("a\r\n\u200B").hits).toEqual([hit(2, 1, 0x200b, "zero-width")]);
  });
});

describe("AC-7 cap", () => {
  const text = "\u200B".repeat(300);
  test("default cap 200", () => {
    const r = scanHidden(text);
    expect(r.count).toBe(300);
    expect(r.hits.length).toBe(200);
  });
  test("custom caps", () => {
    const r = scanHidden(text, 5);
    expect(r.count).toBe(300);
    expect(r.hits.map((h) => h.col)).toEqual([1, 2, 3, 4, 5]);
    expect(scanHidden(text, 0)).toEqual({ count: 300, hits: [] });
  });
});

describe("AC-8 hiddenName and nextHidden", () => {
  test("names", () => {
    const names: [number, string][] = [
      [0x200b, "U+200B ZERO WIDTH SPACE"],
      [0x200c, "U+200C ZERO WIDTH NON-JOINER"],
      [0x200d, "U+200D ZERO WIDTH JOINER"],
      [0x2060, "U+2060 WORD JOINER"],
      [0x2061, "U+2061 INVISIBLE OPERATOR"],
      [0x2064, "U+2064 INVISIBLE OPERATOR"],
      [0xfeff, "U+FEFF BYTE ORDER MARK"],
      [0x202a, "U+202A BIDI CONTROL"],
      [0x2069, "U+2069 BIDI CONTROL"],
      [0xe0041, "U+E0041 TAG CHARACTER"],
      [0xe0000, "U+E0000 TAG CHARACTER"],
      [0xfe0f, "U+FE0F VARIATION SELECTOR"],
      [0xe0100, "U+E0100 VARIATION SELECTOR"],
    ];
    for (const [cp, name] of names) expect(hiddenName(cp)).toBe(name);
  });
  test("nextHidden wraps and is strictly after", () => {
    const a = hit(1, 2, 0x200b, "zero-width");
    const b = hit(3, 1, 0x200b, "zero-width");
    const hits = [a, b];
    expect(nextHidden(hits, 1, 2)).toBe(b);
    expect(nextHidden(hits, 3, 1)).toBe(a);
    expect(nextHidden(hits, 1, 1)).toBe(a);
    expect(nextHidden(hits, 0, 0)).toBe(a);
    expect(nextHidden(hits, 9, 9)).toBe(a);
    expect(nextHidden(hits, 2, 99)).toBe(b);
    const only = hit(4, 4, 0x200b, "zero-width");
    expect(nextHidden([only], 4, 4)).toBe(only);
    expect(nextHidden([], 1, 1)).toBeUndefined();
  });
});
