import { expect, test } from "bun:test";
import { lexLine } from "../src/client/highlight.ts";
import { headingText, symbols } from "../src/client/symbols.ts";
import { parseMarkdown } from "../src/client/markdown.ts";

// Untrusted files must not freeze the UI thread: each input below took seconds before round 15.
const time = (f: () => void) => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

test("JS lexer: many slashes after a long identifier stay linear (was cubic: 76 s for 10 KB)", () => {
  expect(time(() => lexLine("js", "a".repeat(5000) + " /".repeat(2500), 0, []))).toBeLessThan(300);
  const spans = (l: string) => {
    const out: [number, number, string][] = [];
    lexLine("js", l, 0, out as never);
    return out.filter((s) => s[2] === "s").map((s) => l.slice(s[0], s[1]));
  };
  expect(spans("return /ab+c/g.test(s);")).toEqual(["/ab+c/g"]);
  expect(spans("x = typeof   /x/;")).toEqual(["/x/"]);
  expect(spans("x = a / b / c;")).toEqual([]);
  expect(spans("x = areturn / 2 / 3;")).toEqual([]);
  expect(spans("x = averyveryverylongname / 2 / 3;")).toEqual([]);
});

test("Go to Symbol: whitespace runs, TOML and long headings stay fast", () => {
  const java = Array.from({ length: 50 }, () => "public " + " ".repeat(990) + "b");
  expect(time(() => symbols("java", java))).toBeLessThan(300);
  expect(symbols("java", ["public   static  void   main(String[] a) {"]).map((s) => s.name)).toEqual(["main"]);
  const toml = Array.from({ length: 50 }, () => "[" + " ".repeat(998));
  expect(time(() => symbols("toml", toml))).toBeLessThan(300);
  expect(symbols("toml", ["[  tool.x  ]"]).map((s) => s.name)).toEqual(["tool.x"]);
  expect(time(() => symbols("md", ["# a" + " ".repeat(40000) + "b"]))).toBeLessThan(300);
  expect(time(() => headingText("[".repeat(20000)))).toBeLessThan(100);
  expect(headingText("see [the *docs*](x.md) now")).toBe("see the docs now");
});

test("YAML keys and bare URL trimming stay linear", () => {
  expect(time(() => { for (let i = 0; i < 10; i++) lexLine("yaml", " ".repeat(9998) + "x", 0, []); })).toBeLessThan(300);
  const out: [number, number, string][] = [];
  lexLine("yaml", "  - name  : x", 0, out as never);
  expect(out[0]).toEqual([4, 8, "p"]);
  const src = Array.from({ length: 50 }, () => "http://a" + ")".repeat(1990)).join("\n\n");
  expect(time(() => parseMarkdown(src))).toBeLessThan(300);
});
