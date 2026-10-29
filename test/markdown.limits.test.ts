import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installDom, uninstallDom } from "./helpers/fakedom.ts";

let M: typeof import("../src/client/markdown.ts");
let R: typeof import("../src/client/mdrender.ts");
beforeAll(async () => {
  installDom();
  try {
    M = await import("../src/client/markdown.ts");
    R = await import("../src/client/mdrender.ts");
  } catch {}
});
afterAll(() => uninstallDom());

const run = (src: string) => R.renderMarkdown(M.parseMarkdown(src));
/** Best of three, so one scheduler hiccup cannot fail a bound. */
function time(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

// Never run two bun test suites at once: these bounds are wall-clock.
const corpus: Record<string, (n: number) => string> = {
  "stars": (n) => "*".repeat(n),
  "open brackets": (n) => "[".repeat(n),
  "quote markers on one line": (n) => "> ".repeat(n),
  "list markers on one line": (n) => "- ".repeat(n),
  "backticks": (n) => "`".repeat(n),
  "image openers": (n) => "![](".repeat(n),
  "one huge line": (n) => "a".repeat(n * 10),
  "nested quote lines": (n) => "> ".repeat(n) + "x",
  "many short star lines": (n) => "*a ".repeat(Math.floor(n / 10)).split(" ").join("\n"),
  "many bracket lines": (n) => "[a](\n".repeat(Math.floor(n / 10)),
  "many quote lines": (n) => "> x\n".repeat(n),
  "many list lines": (n) => "- x\n".repeat(n),
};

describe("AC-9 adversarial inputs", () => {
  for (const [name, gen] of Object.entries(corpus)) {
    test(`${name}: no throw, under 1 s`, () => {
      const src = gen(100_000);
      let ms = 0;
      expect(() => {
        const t0 = performance.now();
        run(src);
        ms = performance.now() - t0;
      }).not.toThrow();
      expect(ms).toBeLessThan(1000);
    });

    test(`${name}: doubling the input costs less than 3x`, () => {
      const a = time(() => run(gen(40_000)));
      const b = time(() => run(gen(80_000)));
      // The 25 ms floor keeps timer noise on tiny runs from deciding the outcome.
      expect(b).toBeLessThan(3 * Math.max(a, 25));
    });
  }

  test("100k levels of nesting do not throw or overflow the stack", () => {
    expect(() => run("> ".repeat(100_000) + "x")).not.toThrow();
    expect(() => run("- ".repeat(100_000) + "x")).not.toThrow();
  });
});

function containerDepth(blocks: any[]): number {
  let d = 0;
  for (const b of blocks) {
    if (b.type === "blockquote") d = Math.max(d, 1 + containerDepth(b.children));
    else if (b.type === "list") for (const it of b.items) d = Math.max(d, 1 + containerDepth(it.children));
  }
  return d;
}
function collect(nodes: any[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (typeof n.value === "string") out.push(n.value);
    if (n.children) collect(n.children, out);
    if (n.items) collect(n.items, out);
  }
  return out;
}
function inlineDepth(nodes: any[]): number {
  let d = 0;
  for (const n of nodes) if (n.children) d = Math.max(d, 1 + inlineDepth(n.children));
  return d;
}

describe("AC-9 caps degrade to literal text", () => {
  test("block quote nesting beyond 32 becomes literal text", () => {
    const ast = M.parseMarkdown("> ".repeat(100) + "x");
    expect(containerDepth(ast)).toBeLessThanOrEqual(32);
    expect(containerDepth(ast)).toBeGreaterThan(1);
    const text = collect(ast).join("");
    expect(text).toContain("x");
    expect(text).toContain(">");
  });

  test("list nesting beyond 32 becomes literal text", () => {
    const ast = M.parseMarkdown("- ".repeat(100) + "x");
    expect(containerDepth(ast)).toBeLessThanOrEqual(32);
    expect(containerDepth(ast)).toBeGreaterThan(1);
    expect(collect(ast).join("")).toContain("x");
  });

  test("exactly 32 levels still nest", () => {
    expect(containerDepth(M.parseMarkdown("> ".repeat(32) + "x"))).toBe(32);
  });

  test("inline nesting beyond 32 is capped", () => {
    const n = 100;
    let s = "";
    for (let i = 0; i < n; i++) s += (i % 2 ? "_" : "*") + "a ";
    s += "a";
    for (let i = n - 1; i >= 0; i--) s += " a" + (i % 2 ? "_" : "*");
    const ast = M.parseMarkdown(s) as any[];
    expect(ast.length).toBe(1);
    expect(inlineDepth(ast[0].children)).toBeLessThanOrEqual(32);
    expect(inlineDepth(ast[0].children)).toBeGreaterThan(1);
  });

  test("a line over 10,000 inline characters is literal text", () => {
    const line = "*a* ".repeat(4000).trim(); // 15,999 characters
    expect(line.length).toBeGreaterThan(10_000);
    const [p] = M.parseMarkdown(line) as any[];
    expect(p.children).toEqual([{ type: "text", value: line }]);
  });

  test("a line under the cap is still parsed", () => {
    const line = "*a* ".repeat(100).trim();
    const [p] = M.parseMarkdown(line) as any[];
    expect(p.children.some((c: any) => c.type === "em")).toBe(true);
  });
});
