import { describe, expect, test } from "bun:test";
import { Highlighter, languageFor, languageName, lexLine, type Span } from "../src/client/highlight.ts";

const toks = (lang: string, src: string, line = 0) => {
  const lines = src.split("\n");
  const hl = new Highlighter(lang, lines);
  return hl.line(line).map(([s, e, t]) => `${t}:${lines[line]!.slice(s, e)}`);
};

describe("highlight: languages and names", () => {
  test("languageName", () => {
    expect(languageName("js")).toBeTruthy();
    expect(languageName("nope")).toBe("Plain Text");
    expect(languageName("text")).toBe("Plain Text");
  });

  test("languageFor by name and prefix", () => {
    expect(languageFor("Dockerfile.dev")).toBe("docker");
    expect(languageFor("x/y/CMakeLists.txt")).toBe("make");
    expect(languageFor("a.json")).toBe("json");
    expect(languageFor("noext")).toBe("text");
  });

  test("text language yields no tokens", () => {
    expect(new Highlighter("text", ["anything 1 2"]).line(0)).toEqual([]);
    expect(lexLine("nope", "x", 0, [])).toBe(0);
  });

  test("very long lines are skipped", () => {
    const long = "a".repeat(10_001);
    const hl = new Highlighter("js", [long, "const x"]);
    expect(hl.line(0)).toEqual([]);
    expect(hl.line(1).map((s) => s[2])).toEqual(["k"]);
  });
});

describe("highlight: css", () => {
  test("properties, colors, at-rules, functions, variables", () => {
    expect(toks("css", "a { color: #fff; margin: 0 auto; }")).toEqual(["p:color", "n:#fff", "p:margin", "n:0"]);
    expect(toks("css", "@media screen { x: y; }")).toEqual(["k:@media", "p:x"]);
    expect(toks("css", "  --brand: red;")).toEqual(["p:--brand"]);
    expect(toks("css", "  width: calc(1px + var(--brand));")).toEqual(["p:width", "f:calc", "n:1px", "f:var", "v:--brand"]);
    expect(toks("css", "x { color: red !important; }")).toEqual(["p:color", "k:!important"]);
  });

  test("pseudo-class selectors are not properties", () => {
    expect(toks("css", "a:hover {")).not.toContain("p:a");
  });

  test("lone @ or ! is skipped", () => {
    expect(toks("css", "@ x")).toEqual([]);
  });
});

describe("highlight: shell, php, ruby-like variables and at-sigils", () => {
  test("shell $variables", () => {
    expect(toks("sh", 'echo $HOME ${USER} $(pwd) $? "x"')).toEqual(["k:echo", "v:$HOME", "v:${USER}", "v:$(", "v:$?", 's:"x"']);
  });

  test("lone $ is not a var", () => {
    expect(toks("sh", "echo $ x")).toEqual(["k:echo"]);
  });

  test("decorators / annotations", () => {
    expect(toks("js", "@Component() class A {}")).toEqual(["m:@Component", "k:class"]);
    expect(toks("py", "@app.route")).toEqual(["m:@app.route"]);
    expect(toks("js", "a @ b")).toEqual([]);
  });

  test("C preprocessor", () => {
    expect(toks("c", "#include <stdio.h>")).toEqual(["m:#include"]);
    expect(toks("c", "int main() { return 0; }")).toContain("f:main");
  });
});

describe("highlight: config formats", () => {
  test("json keys vs values", () => {
    expect(toks("json", '{"a": "b", "n": 12, "t": true}')).toEqual(["p:\"a\"", 's:"b"', 'p:"n"', "n:12", 'p:"t"', "o:true"]);
  });

  test("yaml keys and values", () => {
    expect(toks("yaml", "name: hello # c")).toEqual(["p:name", "c:# c"]);
    expect(toks("yaml", '  - "quoted": 1')).toEqual(['p:"quoted"', "n:1"]);
    expect(toks("yaml", "key: 'x'")).toEqual(["p:key", "s:'x'"]);
  });

  test("toml sections and keys", () => {
    expect(toks("toml", "[package]")).toEqual(["h:[package]"]);
    expect(toks("toml", "[[bin]]")).toEqual(["h:[[bin]]"]);
    expect(toks("toml", 'name = "x"')).toEqual(["p:name", 's:"x"']);
    expect(toks("toml", "a.b = 3")).toEqual(["p:a.b", "n:3"]);
  });

  test("toml multiline strings span lines", () => {
    const src = 'x = """a\nb\nc""" # t';
    expect(toks("toml", src, 1)).toEqual(["s:b"]);
    expect(toks("toml", src, 2)).toEqual(['s:c"""', "c:# t"]);
  });

  test("multi-line string continuing past end without close", () => {
    expect(toks("py", 'x = """a\nb\nc', 2)).toEqual(["s:c"]);
  });

  test("yaml-like text after a multi-line string closes", () => {
    expect(toks("toml", "k = '''a\nb''' x", 1)).toEqual(["s:b'''"]);
  });
});

describe("highlight: js specifics", () => {
  test("regex literals", () => {
    expect(toks("js", "x = /ab+c/gi.test(y)")).toEqual(["s:/ab+c/gi", "f:test"]);
    expect(toks("js", "x = /[/]\\//")).toEqual(["s:/[/]\\//"]);
    expect(toks("js", "return /a/")).toEqual(["k:return", "s:/a/"]);
  });

  test("division is not regex", () => {
    expect(toks("js", "a / b / c")).toEqual([]);
    expect(toks("js", "x = (a) / 2 / 3")).toEqual(["n:2", "n:3"]);
    expect(toks("js", "x = a /")).toEqual([]);
    expect(toks("js", "x = /unterminated")).toEqual([]);
  });

  test("numbers", () => {
    expect(toks("js", "x = 0xFF + 0b101 + 1_000 + 1.5e3 + .5 + 10n")).toEqual(["n:0xFF", "n:0b101", "n:1_000", "n:1.5e3", "n:.5", "n:10n"]);
    expect(toks("js", "abc1 = a2")).toEqual([]);
  });

  test("constants, types, member keywords", () => {
    expect(toks("js", "x = null; MAX_SIZE; Foo.bar; a.class")).toEqual(["o:null", "o:MAX_SIZE", "t:Foo"]);
  });

  test("block comment inside a line then code", () => {
    expect(toks("js", "a /* c */ b /* open")).toEqual(["c:/* c */", "c:/* open"]);
  });

  test("template literal spans lines", () => {
    const src = "x = `a\nb`;";
    expect(toks("js", src, 0)).toEqual(["s:`a"]);
    expect(toks("js", src, 1)).toEqual(["s:b`"]);
  });

  test("unterminated single-line string ends at EOL", () => {
    expect(toks("js", 'x = "abc')).toEqual(['s:"abc']);
  });

  test("rust macros", () => {
    expect(toks("rs", 'println!("x");')).toEqual(["f:println!", 's:"x"']);
  });

  test("sql identifiers are not treated as types", () => {
    expect(toks("sql", "SELECT Name FROM t")).not.toContain("t:Name");
  });

  test("case-insensitive keywords", () => {
    expect(toks("sql", "select * from t").slice(0, 1)).toEqual(["k:select"]);
  });
});

describe("highlight: markup", () => {
  test("tags, attributes, strings", () => {
    expect(toks("markup", '<a href="x" b>t</a>')).toEqual(["x:<a", "a:href", 's:"x"', "a:b", "x:>", "x:</a", "x:>"]);
    expect(toks("markup", "<br/>")).toEqual(["x:<br", "x:/>"]);
    expect(toks("markup", "<?xml version='1.0'?>")).toEqual(["x:<?xml", "a:version", "s:'1.0'", "x:?>"]);
    expect(toks("markup", "<!DOCTYPE html>")).toEqual(["x:<!DOCTYPE", "a:html", "x:>"]);
  });

  test("comments, single and multi-line", () => {
    expect(toks("markup", "a <!-- c --> b")).toEqual(["c:<!-- c -->"]);
    const src = "<!-- start\nmid\nend --> <p>";
    expect(toks("markup", src, 0)).toEqual(["c:<!-- start"]);
    expect(toks("markup", src, 1)).toEqual(["c:mid"]);
    expect(toks("markup", src, 2)).toEqual(["c:end -->", "x:<p", "x:>"]);
  });

  test("tag spanning lines", () => {
    const src = '<div\n  class="a"\n>';
    expect(toks("markup", src, 0)).toEqual(["x:<div"]);
    expect(toks("markup", src, 1)).toEqual(["a:class", 's:"a"']);
    expect(toks("markup", src, 2)).toEqual(["x:>"]);
  });

  test("unterminated attr string and stray <", () => {
    expect(toks("markup", '<a b="oops')).toEqual(["x:<a", "a:b", 's:"oops']);
    expect(toks("markup", "1 < 2")).toEqual([]);
    expect(toks("markup", "<a =>")).toEqual(["x:<a", "x:>"]);
  });
});

describe("highlight: markdown", () => {
  test("headings, quotes, lists", () => {
    expect(toks("md", "## Title")).toEqual(["h:## Title"]);
    expect(toks("md", "> quote")).toEqual(["c:> quote"]);
    expect(toks("md", "- item `code`")).toEqual(["k:- ", "s:`code`"]);
    expect(toks("md", "1. one")).toEqual(["k:1. "]);
  });

  test("inline emphasis, links", () => {
    expect(toks("md", "a **b** and *c* and [l](u) <https://x.y>")).toEqual(["b:**b**", "i:*c*", "l:[l](u)", "l:<https://x.y>"]);
    expect(toks("md", "__b__ _i_ ![img](p)")).toEqual(["b:__b__", "i:_i_", "l:![img](p)"]);
  });

  test("fenced code blocks", () => {
    const src = "```js\nconst x\n```\nafter **b**";
    expect(toks("md", src, 0)).toEqual(["s:```js"]);
    expect(toks("md", src, 1)).toEqual(["s:const x"]);
    expect(toks("md", src, 2)).toEqual(["s:```"]);
    expect(toks("md", src, 3)).toEqual(["b:**b**"]);
    const tilde = "~~~\nx\n~~~";
    expect(toks("md", tilde, 1)).toEqual(["s:x"]);
  });
});

describe("highlight: Highlighter caching", () => {
  test("jumping to a later line computes earlier state; re-query is stable", () => {
    const lines = ["/* a", "b", "c */ x", "d"];
    const hl = new Highlighter("js", lines);
    expect(hl.line(3)).toEqual([]);
    expect(hl.line(1)).toEqual([[0, 1, "c"]]);
    expect(hl.line(2).map((s) => s[2])).toEqual(["c"]);
  });

  test("lexLine returns state for open block comment", () => {
    const out: Span[] = [];
    expect(lexLine("js", "/* open", 0, out)).toBe(1);
    expect(lexLine("js", "still", 1, (out.length = 0, out))).toBe(1);
    expect(lexLine("js", "end */", 1, (out.length = 0, out))).toBe(0);
  });
});

describe("highlight: string escapes", () => {
  test("escaped quote does not end the string", () => {
    expect(toks("js", 'x = "a\\"b" + 1')).toEqual(['s:"a\\"b"', "n:1"]);
  });
});
