import { describe, expect, test } from "bun:test";
import gfm from "./fixtures/md-gfm.json";

// Loaded dynamically so a missing module fails by assertion rather than by a load error.
let M: typeof import("../src/client/markdown.ts");
try {
  M = await import("../src/client/markdown.ts");
} catch {}

describe("AC-15/16/17 GFM tables, task lists and strikethrough (fixtures/md-gfm.json)", () => {
  for (const c of gfm as { name: string; src: string; ast: unknown }[]) {
    test(c.name, () => {
      expect(M.parseMarkdown(c.src)).toEqual(c.ast as never);
    });
  }
});

describe("AC-15 table column cap", () => {
  const row = (n: number, cell: string) => "|" + Array.from({ length: n }, () => cell).join("|") + "|";

  test("200 columns is still a table", () => {
    const ast = M.parseMarkdown(`${row(200, " a ")}\n${row(200, "---")}\n${row(200, " b ")}`);
    expect(ast.length).toBe(1);
    expect(ast[0]!.type).toBe("table");
    expect((ast[0] as { align: unknown[] }).align.length).toBe(200);
  });

  test("201 columns degrade to a paragraph and never throw", () => {
    const ast = M.parseMarkdown(`${row(201, " a ")}\n${row(201, "---")}\n${row(201, " b ")}`);
    expect(ast.some((b) => b.type === "table")).toBe(false);
    expect(ast[0]!.type).toBe("paragraph");
  });

  test("a huge column count stays linear and does not throw", () => {
    const n = 50_000;
    const t0 = performance.now();
    const ast = M.parseMarkdown(`${row(n, " a ")}\n${row(n, "-")}\n${row(n, " b ")}`);
    expect(ast.some((b) => b.type === "table")).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("GFM syntax never reaches the AST as raw strings", () => {
  test("a task item carries a boolean, not marker text", () => {
    const [list] = M.parseMarkdown("- [x] done") as { items: { checked?: boolean; children: unknown[] }[] }[];
    expect(list!.items[0]!.checked).toBe(true);
    expect(JSON.stringify(list!.items[0]!.children)).not.toContain("[x]");
  });
});
