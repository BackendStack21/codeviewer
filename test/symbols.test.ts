import { describe, expect, test } from "bun:test";
import { hasSymbols, headingText, MAX_SYMBOLS, symbols } from "../src/client/symbols.ts";

const names = (lang: string, src: string) => symbols(lang, src.split("\n")).map((s) => `${s.kind[0]}:${s.name}@${s.line}`);

describe("symbols: TypeScript / JavaScript", () => {
  test("declarations, exported or not, with their 0-based lines", () => {
    const src = [
      "export interface Info {",
      "  name: string;",
      "}",
      "type Id = string;",
      "export enum Mode { A }",
      "export default class App extends Base {",
      "  private count = 0;",
      "  constructor(a: number) {",
      "  }",
      "  async load(path: string): Promise<void> {",
      "  get size() {",
      "  private onKey = (e: KeyboardEvent) => {",
      "  if (x) {",
      "}",
      "export async function main() {}",
      "function* gen() {}",
      "const add = (a: number, b: number) => a + b;",
      "export const handler = async (req) => {",
      "export const LIMIT = 10;",
      "const local = 5;",
    ].join("\n");
    expect(names("js", src)).toEqual([
      "t:Info@0", "t:Id@3", "t:Mode@4", "c:App@5", "f:constructor@7", "f:load@9", "f:size@10", "f:onKey@11",
      "f:main@14", "f:gen@15", "f:add@16", "f:handler@17", "v:LIMIT@18",
    ]);
  });

  test("control flow and calls are not symbols", () => {
    expect(names("js", ["if (a) {", "for (const x of y) {", "while (true) {", "switch (k) {", "foo(bar);", "return x;"].join("\n"))).toEqual([]);
  });

  test("comments are skipped, including block comments over several lines", () => {
    const src = ["// function fake() {}", "/*", " * class Nope {", " */", "/* class Inline {} */", "function real() {}"].join("\n");
    expect(names("js", src)).toEqual(["f:real@5"]);
  });

  test("depth is the indentation, tabs counting 4", () => {
    const s = symbols("js", ["class A {", "\tm() {", "  }", "}"]);
    expect(s.map((x) => x.depth)).toEqual([0, 4]);
  });
});

describe("symbols: other languages", () => {
  test("Python, skipping docstrings and comments", () => {
    const src = ['class Foo(Base):', '    """', '    class of things', '    def not_this', '    """', "    def bar(self):", "    async def baz(self):", "# def commented():", "def top():"].join("\n");
    expect(names("py", src)).toEqual(["c:Foo@0", "f:bar@5", "f:baz@6", "f:top@8"]);
  });
  test("Rust", () => {
    expect(names("rs", ["pub struct S;", "impl<T> Trait for S {", "    pub(crate) async fn go(&self) {", "enum E {", "mod m;", "macro_rules! mac {"].join("\n"))).toEqual([
      "t:S@0", "c:Trait for S@1", "f:go@2", "t:E@3", "s:m@4", "f:mac@5",
    ]);
  });
  test("Go", () => {
    expect(names("go", ["func main() {", "func (s *Server) Start() error {", "type Server struct {", "type ID string"].join("\n"))).toEqual([
      "f:main@0", "f:Start@1", "c:Server@2", "t:ID@3",
    ]);
  });
  test("C/C++: definitions, not prototypes or calls", () => {
    expect(names("c", ["#define MAX 10", "static int add(int a, int b) {", "int proto(void);", "struct point {", "void Foo::bar() const {", "  return add(1, 2);"].join("\n"))).toEqual([
      "v:MAX@0", "f:add@1", "c:point@3", "f:Foo::bar@4",
    ]);
  });
  test("Java, Kotlin, C#", () => {
    expect(names("java", ["public final class Main {", "  public static void main(String[] args) {", "  private List<String> names() {", "  suspend fun load(): Unit {", "data class P(val x: Int)"].join("\n"))).toEqual([
      "c:Main@0", "f:main@1", "f:names@2", "f:load@3", "c:P@4",
    ]);
  });
  test("Swift, Ruby, PHP, Lua, shell", () => {
    expect(names("swift", ["final class V: NSView {", "  override func draw(_ r: NSRect) {"].join("\n"))).toEqual(["c:V@0", "f:draw@1"]);
    expect(names("rb", ["module M", "  class C", "    def self.make", "    def ok?"].join("\n"))).toEqual(["c:M@0", "c:C@1", "f:self.make@2", "f:ok?@3"]);
    expect(names("php", ["final class K {", "  public static function make() {"].join("\n"))).toEqual(["c:K@0", "f:make@1"]);
    expect(names("lua", ["local function f()", "function M.g()", "M.h = function()"].join("\n"))).toEqual(["f:f@0", "f:M.g@1", "f:M.h@2"]);
    expect(names("sh", ["build() {", "function deploy {", "# fake() {"].join("\n"))).toEqual(["f:build@0", "f:deploy@1"]);
  });
  test("config-like files list top-level keys and sections only", () => {
    expect(names("yaml", ["name: x", "jobs:", "  build:", "    steps:"].join("\n"))).toEqual(["s:name@0", "s:jobs@1"]);
    expect(names("toml", ["[package]", "name = 1", "[[bin]]"].join("\n"))).toEqual(["s:package@0", "s:bin@2"]);
    expect(names("make", ["all: build", "VAR := 1", "\tcc -o x", "build:"].join("\n"))).toEqual(["f:all@0", "f:build@3"]);
  });
  test("unknown languages have no outline; very long lines are skipped", () => {
    expect(hasSymbols("text")).toBe(false);
    expect(hasSymbols("json")).toBe(false);
    expect(hasSymbols("md")).toBe(true);
    expect(symbols("text", ["function x() {}"])).toEqual([]);
    expect(symbols("js", ["function " + "x".repeat(2000) + "() {}"])).toEqual([]);
  });
  test("the list is capped", () => {
    const lines = Array.from({ length: MAX_SYMBOLS + 10 }, (_, i) => `function f${i}() {}`);
    expect(symbols("js", lines).length).toBe(MAX_SYMBOLS);
  });
});

describe("symbols: Markdown headings", () => {
  test("ATX and setext headings with levels as depth; fenced code is not scanned", () => {
    const src = ["# Title #", "", "Intro", "Sub", "---", "```sh", "# not a heading", "```", "~~~", "## also not", "~~~", "### Deep", "Other", "===", "- item", "---", "#nospace"].join("\n");
    const s = symbols("md", src.split("\n"));
    expect(s.map((x) => `${x.depth}:${x.name}@${x.line}`)).toEqual(["0:Title@0", "1:Sub@3", "2:Deep@11", "0:Other@12"]);
  });
  test("an unclosed fence hides the rest", () => {
    expect(symbols("md", ["# A", "```", "# B"]).map((x) => x.name)).toEqual(["A"]);
  });
  test("headingText drops inline markup for the slug", () => {
    expect(headingText("The `codeviewer open` **command** [docs](x.md)")).toBe("The codeviewer open command docs");
  });
});
