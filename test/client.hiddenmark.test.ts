import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { uninstallDom } from "./helpers/fakedom.ts";
import { loadCodeView, type Env } from "./helpers/selfake.ts";
import { scanHidden } from "../src/client/hidden.ts";

let env: Env;
let markHidden: typeof import("../src/client/codeview.ts").markHidden;
let markBidi: typeof import("../src/client/codeview.ts").markBidi;
let MAX: number;
beforeAll(async () => {
  env = await loadCodeView();
  ({ markHidden, markBidi, MAX_BIDI_MARKS: MAX } = env.C);
});
afterAll(() => uninstallDom());

const ZW = "\u200B";
const span = (title: string, run: string) => `<span class="hidden-char" title="${title}">${run}</span>`;
const unwrap = (html: string) => html.replace(/<span class="hidden-char" title="[^"]*">/g, "").split("</span>").join("");
const spans = (html: string) => (html.match(/<span class="(?:hidden-char|bidi)"/g) ?? []).length;
/** Code points inside hidden-char wrappers, in order. */
const wrapped = (html: string) =>
  [...html.matchAll(/<span class="hidden-char" title="[^"]*">([^<]*)<\/span>/g)].flatMap((m) => [...m[1]!].map((c) => c.codePointAt(0)!));

describe("AC-16 markHidden basics", () => {
  test("a zero-width space is wrapped with its name", () => {
    expect(markHidden("a" + ZW + "b")).toBe("a" + span("U+200B ZERO WIDTH SPACE", ZW) + "b");
  });
  test("a run is one span titled by its first character; ZWJ after U+200B counts", () => {
    expect(markHidden("x" + ZW + ZW + "\u200D" + "y")).toBe("x" + span("U+200B ZERO WIDTH SPACE", ZW + ZW + "\u200D") + "y");
  });
  test("a tag run is one span titled by its first tag character", () => {
    const run = "\u{E0041}\u{E0042}\u{E0043}";
    expect(markHidden("a" + run + "b")).toBe("a" + span("U+E0041 TAG CHARACTER", run) + "b");
  });
  test("runs of 9 get a count title, runs of 8 the first-character title", () => {
    expect(markHidden(ZW.repeat(9))).toBe(span("9 hidden characters", ZW.repeat(9)));
    expect(markHidden(ZW.repeat(8))).toBe(span("U+200B ZERO WIDTH SPACE", ZW.repeat(8)));
  });
  test("mixed kinds make one span", () => {
    const run = ZW + "\u{E0041}" + "\u{E0100}";
    expect(markHidden("a" + run + "b")).toBe("a" + span("U+200B ZERO WIDTH SPACE", run) + "b");
  });
  test("a string without counted characters is returned as is", () => {
    const s = "plain &amp; text \u200E\u200F\u00AD";
    expect(markHidden(s)).toBe(s);
  });
  test("a BOM inside the line is wrapped", () => {
    expect(markHidden("a\uFEFFb")).toBe("a" + span("U+FEFF BYTE ORDER MARK", "\uFEFF") + "b");
  });
  test("emoji variation and joiner sequences are not marked", () => {
    expect(markHidden("\u{1F600}\uFE0F")).toBe("\u{1F600}\uFE0F");
    expect(markHidden("\u{1F468}\u200D\u{1F469}")).toBe("\u{1F468}\u200D\u{1F469}");
    expect(markHidden("\u06CC\u200Cx")).toBe("\u06CC\u200Cx");
  });
  test("only the second of two FE0F after an emoji is wrapped", () => {
    expect(markHidden("\u{1F600}\uFE0F\uFE0F")).toBe("\u{1F600}\uFE0F" + span("U+FE0F VARIATION SELECTOR", "\uFE0F"));
  });
  test("bidi controls are left for markBidi", () => {
    expect(markHidden("a\u202Eb")).toBe("a\u202Eb");
  });
});

describe("AC-16b context", () => {
  test("a joiner after an emoji or a letter", () => {
    expect(markHidden("\u200Dx", undefined, { prev: 0x1f468 })).toBe("\u200Dx");
    expect(markHidden("\u200Dx", undefined, { prev: 0x61 })).toBe(span("U+200D ZERO WIDTH JOINER", "\u200D") + "x");
    expect(markHidden("\u200Dx")).toBe(span("U+200D ZERO WIDTH JOINER", "\u200D") + "x");
    expect(markHidden("\u200Dx", undefined, { prev: 0x0a })).toBe(span("U+200D ZERO WIDTH JOINER", "\u200D") + "x");
  });
  test("a variation selector after another one", () => {
    expect(markHidden("\uFE01", undefined, { prev: 0xfe00 })).toBe(span("U+FE01 VARIATION SELECTOR", "\uFE01"));
    expect(markHidden("\uFE01", undefined, { prev: 0x61 })).toBe("\uFE01");
  });
  test("a BOM is exempt only at the start of the file", () => {
    expect(markHidden("\uFEFFx")).toBe(span("U+FEFF BYTE ORDER MARK", "\uFEFF") + "x");
    expect(markHidden("\uFEFFx", undefined, { atFileStart: true })).toBe("\uFEFFx");
  });
});

describe("AC-17 the text is preserved", () => {
  test("removing the wrappers gives the input back", () => {
    for (const s of ["a" + ZW + "b", ZW.repeat(9), "x\u200B\u200B\u200Dy", "a\u{E0041}\u{E0042}b\u{E0100}", "&amp;" + ZW, "\u{1F600}\uFE0F\uFE0F", "p&lt;q" + ZW + "\u2060&gt;"]) {
      expect(unwrap(markHidden(s))).toBe(s);
    }
    expect(markHidden("&amp;" + ZW)).toBe("&amp;" + span("U+200B ZERO WIDTH SPACE", ZW));
  });
});

describe("AC-18 the per-line budget", () => {
  test("the default budget is MAX_BIDI_MARKS spans, the rest are escapes", () => {
    const out = markHidden("a" + ZW);
    expect(spans(out)).toBe(1);
    const many = markHidden(("a" + ZW).repeat(40));
    expect(spans(many)).toBe(MAX);
    expect(many.split("\\u200b").length - 1).toBe(40 - MAX);
    expect(many.replace(/<span class="hidden-char"[^>]*>[^<]*<\/span>/g, "")).not.toContain(ZW);
  });
  test("astral characters past the budget become braced escapes", () => {
    const b = { left: 1 };
    const out = markHidden("a\u{E0041}b\u{E0041}", b);
    expect(spans(out)).toBe(1);
    expect(b.left).toBe(0);
    expect(out).toContain("\\u{e0041}");
    expect(out.replace(/<span class="hidden-char"[^>]*>[^<]*<\/span>/g, "")).not.toContain("\u{E0041}");
  });
  test("a budget of 0 escapes everything", () => {
    expect(markHidden("a" + ZW + "b", { left: 0 })).toBe("a\\u200bb");
  });
  test("the budget is shared with markBidi", () => {
    const b = { left: 2 };
    const out = markBidi(markHidden("a" + ZW + "b" + ZW + "c\u202E", b), b);
    expect(spans(out)).toBe(2);
    expect(out).toContain("\\u202e");
    expect(out.replace(/<span class="(?:hidden-char|bidi)"[^>]*>[^<]*<\/span>/g, "")).not.toMatch(/[\u200B\u202E]/);
  });
});

type View = { lineHtml(i: number): string; sr: { line: number; start: number; end: number } | null };
const view = (text: string, lang = "text") => new env.C.CodeView(text, lang, 10) as unknown as View;

describe("AC-19 rendered lines", () => {
  test("a line with a hidden character shows the span and a bidi line keeps .bidi", () => {
    const v = view("a" + ZW + "b\nx\u202Ey\nplain");
    expect(v.lineHtml(0)).toContain(span("U+200B ZERO WIDTH SPACE", ZW));
    expect(v.lineHtml(1)).toContain('<span class="bidi" title="U+202E">');
    expect(v.lineHtml(2)).toBe("plain");
  });
  test("highlighted lines are marked too, and the cache returns the same html", () => {
    const v = view('const s = "a' + ZW + 'b"; // c' + ZW + "\n", "js");
    const html = v.lineHtml(0);
    expect((html.match(/class="hidden-char"/g) ?? []).length).toBe(2);
    expect(v.lineHtml(0)).toBe(html);
  });
  test("truncated long lines are still marked", () => {
    const html = view(ZW + "a".repeat(5000)).lineHtml(0);
    expect(html).toContain('class="hidden-char"');
    expect(html).toContain('class="trunc"');
  });
  test("markers per line are bounded across hidden and bidi together", () => {
    const html = view(("a" + ZW).repeat(40) + ("b\u202E").repeat(40)).lineHtml(0);
    expect(spans(html)).toBe(MAX);
    expect(html.replace(/<span class="(?:hidden-char|bidi)"[^>]*>[^<]*<\/span>/g, "")).not.toMatch(/[\u200B\u202E]/);
  });
});

describe("AC-19b rendered segments agree with scanHidden", () => {
  const agree = (v: View, text: string) => {
    const hits = scanHidden(text).hits.filter((h) => h.kind !== "bidi");
    text.split("\n").forEach((_, i) => {
      expect(wrapped(v.lineHtml(i))).toEqual(hits.filter((h) => h.line === i + 1).map((h) => h.cp));
    });
  };
  test("a joiner after an emoji in the previous segment is exempt, after a letter it is marked", () => {
    const text = "\u{1F600}\u200D\u200Dz\na\u200Dz";
    const v = view(text);
    v.sr = { line: 0, start: 2, end: 3 }; // a mark boundary right after the emoji
    expect(wrapped(v.lineHtml(0))).toEqual([0x200d]); // first ZWJ follows the emoji (exempt), the second follows a ZWJ
    agree(v, text);
    v.sr = { line: 1, start: 1, end: 2 }; // the ZWJ starts its own segment after "a"
    expect(wrapped(v.lineHtml(1))).toEqual([0x200d]);
    agree(v, text);
  });
  test("a variation selector starting a segment after another one is marked", () => {
    const text = "a\uFE00\uFE01b";
    const v = view(text);
    v.sr = { line: 0, start: 2, end: 3 };
    expect(wrapped(v.lineHtml(0))).toEqual([0xfe01]);
    agree(v, text);
  });
  test("across real token boundaries of a highlighted language", () => {
    const text = 'x = "a"\u200D + "\u{1F600}"\u200D; // \u200D\n"\u{1F600}\u200D"\u200B';
    const v = view(text, "js");
    agree(v, text);
    expect(wrapped(v.lineHtml(0)).length).toBeGreaterThan(0);
  });
  test("a BOM starting line 2 is marked, one starting line 1 is not", () => {
    const text = "\uFEFFa\n\uFEFFb";
    const v = view(text);
    expect(wrapped(v.lineHtml(0))).toEqual([]);
    expect(wrapped(v.lineHtml(1))).toEqual([0xfeff]);
    agree(v, text);
  });
  test("a joiner starting line 2 follows a newline and is marked", () => {
    const text = "\u{1F600}\n\u200Dx";
    const v = view(text);
    expect(wrapped(v.lineHtml(1))).toEqual([0x200d]);
    agree(v, text);
  });
});
