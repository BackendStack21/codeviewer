import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installDom, uninstallDom } from "./helpers/fakedom.ts";
import { parseMarkdown } from "../src/client/markdown.ts";
import { symbols } from "../src/client/symbols.ts";
import { lexLine, type Span } from "../src/client/highlight.ts";
import { createHiddenNav, type HiddenNavHost } from "../src/client/hiddennav.ts";

// Untrusted file content: time bounds on pathological input, and lexer state that must not leak.

const ms = (f: () => void) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

describe("Markdown entity scan", () => {
  test("a paragraph of many `&` parses in linear time (each one searched the whole paragraph for `;`)", () => {
    const control = ms(() => parseMarkdown("a\n".repeat(250_000)));
    const amp = ms(() => parseMarkdown("&\n".repeat(250_000)));
    const words = ms(() => parseMarkdown("Q&A row\n".repeat(60_000)));
    expect(amp).toBeLessThan(control * 8 + 150);
    expect(words).toBeLessThan(control * 8 + 150);
  });

  test("entities still decode, and an over-long one stays text", () => {
    const text = (s: string) => JSON.stringify(parseMarkdown(s));
    expect(text("a &amp; b &#x41; &#65; &lt;")).toContain("a & b A A <");
    expect(text("&#x000041;")).toContain('"A"');
    expect(text("&abcdefghijkl; &nosuch;")).toContain("&abcdefghijkl; &nosuch;");
  });
});

describe("Go to Symbol on whitespace other than spaces and tabs", () => {
  for (const [name, ws] of [["NBSP", "\u00A0"], ["form feed", "\f"], ["em space", "\u2003"]] as const) {
    test(`"public" + 990 x ${name} does not backtrack`, () => {
      const line = "public" + ws.repeat(990);
      expect(ms(() => symbols("java", Array(4).fill(line)))).toBeLessThan(120);
      expect(ms(() => symbols("toml", Array(4).fill("[" + ws.repeat(998))))).toBeLessThan(120);
    });
  }
  test("symbols are still found around odd whitespace", () => {
    expect(symbols("java", ["public\u00A0\u00A0class\u00A0Foo {"]).map((s) => s.name)).toEqual(["Foo"]);
  });
});

describe("Go to Next Hidden Character", () => {
  test("reaches a bidi override behind more than 200 zero-width characters", () => {
    const lines = ["\u200B".repeat(250), "clean", "access = \u202E'nimda'"];
    const announced: string[] = [];
    const host: HiddenNavHost = { lines: () => lines, reveal: () => {}, announce: (m) => void announced.push(m), toast: () => {} };
    const nav = createHiddenNav(host);
    for (let i = 0; i < 252; i++) nav.next();
    expect(announced[249]).toBe("U+200B ZERO WIDTH SPACE at line 1, column 250");
    expect(announced[250]).toBe("U+202E BIDI CONTROL at line 3, column 10");
    expect(announced[251]).toBe("U+200B ZERO WIDTH SPACE at line 1, column 1"); // wraps
  });
});

describe("highlighter state across lines", () => {
  const lex = (lang: string, src: string[]) => {
    let st = 0;
    return src.map((l) => {
      const out: Span[] = [];
      st = lexLine(lang, l, st, out);
      return { st, out };
    });
  };

  test("a Lua block comment spans lines", () => {
    const r = lex("lua", ["--[[", "local x = 1", "]] local y = 2", "-- line", "local z"]);
    expect(r[0]!.st).not.toBe(0);
    expect(r[1]!.out).toEqual([[0, 11, "c"]]);
    expect(r[2]!.st).toBe(0);
    expect(r[2]!.out[0]).toEqual([0, 2, "c"]);
    expect(r[3]!).toEqual({ st: 0, out: [[0, 7, "c"]] });
    expect(r[4]!.out.some((s) => s[2] === "c")).toBe(false);
  });

  test("a Rust char literal holding a quote does not open a string", () => {
    for (const first of [`let q = '"';`, `let q = b'"';`, `let q = '\\'';`, `if c == '"' || c == '\\\\' {`, `let e = '\\u{1F600}';`]) {
      const r = lex("rs", [first, "let n = 1; // still code"]);
      expect(r[0]!.st).toBe(0);
      expect(r[1]!.out.at(-1)).toEqual([11, 24, "c"]);
    }
    // Lifetimes are not char literals, and a real string still is one.
    const r = lex("rs", [`fn f<'a>(x: &'a str) -> &'a str { "s" }`]);
    expect(r[0]!.st).toBe(0);
    expect(r[0]!.out.filter((s) => s[2] === "s")).toEqual([[34, 37, "s"]]);
  });
});

describe("shell here-documents", () => {
  const lex = (src: string[]) => {
    let st = 0;
    return src.map((l) => {
      const out: Span[] = [];
      st = lexLine("sh", l, st, out);
      return { st, out };
    });
  };
  test("an apostrophe in the body does not turn the rest of the file into a string", () => {
    const r = lex(["cat <<EOF", "it's fine", "EOF", "echo done # note"]);
    expect(r[1]!.out).toEqual([[0, 9, "s"]]);
    expect(r[2]!.st).toBe(0);
    expect(r[3]!.out.at(-1)).toEqual([10, 16, "c"]);
    expect(r[3]!.out.some((x) => x[2] === "s")).toBe(false);
  });
  test("quoted and dashed delimiters, and two documents with different words", () => {
    const r = lex(["cat <<'END' > out.txt", "don't $x", "END", "cat <<-\"T2\"", "\tisn't", "\tT2", "ls # c"]);
    expect(r[2]!.st).toBe(0);
    expect(r[4]!.out).toEqual([[0, 6, "s"]]);
    expect(r[5]!.st).toBe(0);
    expect(r[6]!.out.at(-1)).toEqual([3, 6, "c"]);
    // The body ends only at its own word.
    const q = lex(["cat <<A", "B", "A x", " A", "A", "true"]);
    expect(q.map((x) => x.st === 0)).toEqual([false, false, false, false, true, true]);
  });
  test("shifts, here-strings and `<<` in a string or comment open nothing", () => {
    for (const line of ["x=$((1 << n))", "(( y = 1 << n ))", "cat <<< word", "echo \"a <<EOF\"", "# cat <<EOF", "echo 'x <<EOF'"]) {
      expect([line, lex([line])[0]!.st]).toEqual([line, 0]);
    }
  });
});

describe("fenced code language names", () => {
  let MR: typeof import("../src/client/mdrender.ts");
  beforeAll(async () => {
    installDom();
    MR = await import("../src/client/mdrender.ts");
  });
  afterAll(() => uninstallDom());
  const spans = (lang: string) => {
    const el = MR.renderMarkdown(parseMarkdown("```" + lang + "\nconst x = 1; // note\n```")) as unknown as { querySelectorAll(s: string): unknown[] };
    return el.querySelectorAll("span").length;
  };
  test("full names and upper case highlight like the short form", () => {
    expect(spans("js")).toBeGreaterThan(0);
    for (const [long, short] of [["javascript", "js"], ["JS", "js"], ["typescript", "ts"], ["TypeScript", "ts"], ["python", "py"], ["rust", "rs"], ["shell", "sh"], ["bash", "sh"], ["golang", "go"], ["ruby", "rb"]]) {
      expect([long, spans(long)]).toEqual([long, spans(short!)]);
    }
    expect(spans("nosuchlanguage")).toBe(0);
    expect(spans("constructor")).toBe(0);
  });
});
