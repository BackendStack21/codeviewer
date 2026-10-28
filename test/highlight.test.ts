import { describe, expect, test } from "bun:test";
import { Highlighter, languageFor } from "../src/client/highlight.ts";

const toks = (lang: string, src: string, line = 0) => {
  const lines = src.split("\n");
  const hl = new Highlighter(lang, lines);
  return hl.line(line).map(([s, e, t]) => `${t}:${lines[line]!.slice(s, e)}`);
};

describe("highlighter", () => {
  test("language detection", () => {
    expect(languageFor("a/b/c.tsx")).toBe("js");
    expect(languageFor("Dockerfile")).toBe("docker");
    expect(languageFor("Makefile")).toBe("make");
    expect(languageFor("x.unknown")).toBe("text");
    expect(languageFor(".env.local")).toBe("sh");
  });

  test("typescript tokens", () => {
    expect(toks("js", `const x = foo("hi", 42); // done`)).toEqual(["k:const", "f:foo", 's:"hi"', "n:42", "c:// done"]);
  });

  test("block comments carry across lines", () => {
    expect(toks("js", "/* start\nmiddle\nend */ let", 1)).toEqual(["c:middle"]);
    expect(toks("js", "/* start\nmiddle\nend */ let", 2)).toEqual(["c:end */", "k:let"]);
  });

  test("python triple-quoted strings", () => {
    expect(toks("py", 'x = """a\nb\nc""" + 1', 1)).toEqual(["s:b"]);
    expect(toks("py", 'x = """a\nb\nc""" + 1', 2)).toEqual(['s:c"""', "n:1"]);
  });

  test("json keys vs values", () => {
    expect(toks("json", `{"name": "x", "n": true}`)).toEqual(['p:"name"', 's:"x"', 'p:"n"', "o:true"]);
  });

  test("markup tags", () => {
    expect(toks("markup", `<a href="x">t</a>`)).toEqual(["x:<a", "a:href", 's:"x"', "x:>", "x:</a", "x:>"]);
  });

  test("markdown fences", () => {
    expect(toks("md", "# Title")).toEqual(["h:# Title"]);
    expect(toks("md", "```\ncode\n```\ntext", 1)).toEqual(["s:code"]);
    expect(toks("md", "```\ncode\n```\ntext", 3)).toEqual([]);
  });

  test("shell variables and comments", () => {
    expect(toks("sh", `echo $HOME # hi`)).toEqual(["k:echo", "v:$HOME", "c:# hi"]);
  });

  test("regex literals don't open comments or strings", () => {
    const src = 's.replace(/\\/*$/, "");\nconst x = 1;';
    expect(toks("js", src, 1)).toEqual(["k:const", "n:1"]);
    expect(toks("js", "a = b / c / d;")).toEqual([]);
    expect(toks("js", "const re = /`[a-z/]+`/g; let y")).toEqual(["k:const", "s:/`[a-z/]+`/g", "k:let"]);
    expect(toks("js", "if (/^#/.test(s)) return /x/i;")).toEqual(["k:if", "s:/^#/", "f:test", "k:return", "s:/x/i"]);
  });
});
