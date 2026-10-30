import { describe, expect, test } from "bun:test";
import cases from "./fixtures/md-cases.json";

// Loaded dynamically so a missing module fails by assertion rather than by a load error.
let M: typeof import("../src/client/markdown.ts");
try {
  M = await import("../src/client/markdown.ts");
} catch {}

describe("AC-1 isMarkdown", () => {
  test.each(["README.MD", "a.markdown", ".md", "docs/guide.Md", "x/y/z.MARKDOWN"])("%s is Markdown", (p) => {
    expect(M.isMarkdown(p)).toBe(true);
  });
  test.each(["x.md.txt", "md", "a.mdx", "notes.txt", "a.md/b", "", "markdown", "a.mdown"])("%s is not Markdown", (p) => {
    expect(M.isMarkdown(p)).toBe(false);
  });
});

describe("parseMarkdown headings and paragraphs (fixtures)", () => {
  for (const c of cases as { name: string; src: string; ast: unknown }[]) {
    test(c.name, () => {
      expect(M.parseMarkdown(c.src)).toEqual(c.ast as never);
    });
  }
});

describe("lists: an empty item followed by a blank line", () => {
  test("stays one (loose) list", () => {
    const blocks = M.parseMarkdown("- a\n-\n\n- c") as { type: string; tight?: boolean; items?: unknown[] }[];
    expect(blocks.map((b) => b.type)).toEqual(["list"]);
    expect(blocks[0]!.items!.length).toBe(3);
    expect(blocks[0]!.tight).toBe(false);
    const ordered = M.parseMarkdown("1. a\n2.\n\n3. c") as { type: string; start?: number; items?: unknown[] }[];
    expect(ordered.map((b) => b.type)).toEqual(["list"]);
    expect(ordered[0]!.items!.length).toBe(3);
    expect(ordered[0]!.start).toBe(1);
  });
  test("an empty item never takes content after the blank line", () => {
    const blocks = M.parseMarkdown("-\n\n  foo") as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["list", "paragraph"]);
  });
});
