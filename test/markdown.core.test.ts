import { describe, expect, test } from "bun:test";
import core from "./fixtures/md-core.json";
import inline from "./fixtures/md-inline.json";

// Loaded dynamically so a missing module fails by assertion rather than by a load error.
let M: typeof import("../src/client/markdown.ts");
try {
  M = await import("../src/client/markdown.ts");
} catch {}

type Case = { name: string; src: string; ast: unknown };

describe("AC-6 block structure (fixtures/md-core.json)", () => {
  for (const c of core as Case[]) {
    test(c.name, () => {
      expect(M.parseMarkdown(c.src)).toEqual(c.ast as never);
    });
  }
});

describe("AC-7 inline syntax (fixtures/md-inline.json)", () => {
  for (const c of inline as Case[]) {
    test(c.name, () => {
      expect(M.parseMarkdown(c.src)).toEqual(c.ast as never);
    });
  }
});

describe("AC-7 invariants", () => {
  test("adjacent text nodes are always merged", () => {
    const walk = (n: any): void => {
      for (const k of ["children", "items"] as const) {
        const kids = n[k] as any[] | undefined;
        if (!kids) continue;
        for (let i = 1; i < kids.length; i++) expect(kids[i].type === "text" && kids[i - 1].type === "text").toBe(false);
        kids.forEach(walk);
      }
    };
    for (const c of [...(core as Case[]), ...(inline as Case[])]) for (const b of M.parseMarkdown(c.src)) walk(b);
  });

  test("entities never produce markup nodes", () => {
    const [p] = M.parseMarkdown("&lt;script&gt;alert(1)&lt;/script&gt;") as any[];
    expect(p.children).toEqual([{ type: "text", value: "<script>alert(1)</script>" }]);
  });
});
