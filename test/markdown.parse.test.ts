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
