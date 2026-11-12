import { describe, expect, test } from "bun:test";
import { parseMarkdown, safeHref } from "../src/client/markdown.ts";

type N = { type: string; value?: string; children?: N[]; items?: { task?: unknown; checked?: unknown; children: N[] }[]; href?: string; [k: string]: unknown };
const doc = (s: string) => parseMarkdown(s) as unknown as { children?: N[] } | N[];
const blocks = (s: string): N[] => {
  const d = doc(s);
  return Array.isArray(d) ? d : (d.children ?? []);
};
/** Every node of a tree, depth first. */
const walk = (n: unknown, out: N[] = []): N[] => {
  if (Array.isArray(n)) for (const x of n) walk(x, out);
  else if (n && typeof n === "object") {
    out.push(n as N);
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v, out);
  }
  return out;
};
const types = (s: string) => walk(doc(s)).map((n) => n.type).filter(Boolean);
const textOf = (s: string) => walk(doc(s)).filter((n) => n.type === "text").map((n) => n.value).join("");

describe("task list items keep their text as a paragraph", () => {
  test("text that looks like a block start stays text", () => {
    for (const [src, text] of [
      ["- [ ] 1. write tests", "1. write tests"],
      ["- [x] # not a heading", "# not a heading"],
      ["- [ ] > not a quote", "> not a quote"],
      ["- [ ] - not a nested item", "- not a nested item"],
      ["- [ ] 2) second", "2) second"],
    ] as const) {
      const t = types(src);
      expect([src, t.filter((x) => x === "list").length]).toEqual([src, 1]);
      expect([src, t.includes("heading") || t.includes("blockquote")]).toEqual([src, false]);
      expect([src, textOf(src)]).toEqual([src, text]);
    }
  });
  test("ordinary task text is unchanged, inline markup included", () => {
    expect(textOf("- [ ] *em* and [link](https://example.com)")).toBe("em and link");
    expect(types("- [ ] *em* and [link](https://example.com)")).toContain("link");
    expect(JSON.stringify(doc("- [x] done"))).toContain("true");
  });
});

describe("setext headings", () => {
  test("a hard break inside a multi-line heading survives", () => {
    expect(types("line one  \nline two\n---")).toContain("break");
    expect(types("line one\\\nline two\n===")).toContain("break");
    expect(types("line one\nline two\n---")).not.toContain("break");
  });
  test("trailing spaces of the last line and leading spaces are still dropped", () => {
    expect(textOf("  Title   \n===")).toBe("Title");
  });
});

describe("bare URLs next to emphasis", () => {
  test("a URL right after `_` is linked, as after `*`", () => {
    for (const src of ["_https://example.com/a_", "*https://example.com/a*"]) {
      const link = walk(doc(src)).find((n) => n.type === "link");
      expect([src, link?.href]).toEqual([src, "https://example.com/a"]);
      expect([src, types(src).includes("emphasis") || types(src).includes("em")]).toEqual([src, true]);
    }
  });
  test("a URL glued to a word is still not linked", () => {
    expect(types("xhttps://example.com/a")).not.toContain("link");
    expect(types("snake_https://example.com/a")).not.toContain("link");
  });
});

describe("safeHref does not decode entities a second time", () => {
  test("an ampersand entity that survived the parser is literal text of the URL", () => {
    expect(safeHref("https://example.com/?a=1&amp;b=2")?.href).toBe("https://example.com/?a=1&amp;b=2");
    expect(safeHref("docs/a&lt;b.md")).toEqual({ kind: "repo", href: "docs/a&lt;b.md" });
  });
  test("a scheme hidden behind entities is still refused", () => {
    for (const s of ["&#x6A;avascript:alert(1)", "&#106;avascript:alert(1)", "java&#10;script:alert(1)", "&#47;&#47;evil.example/x", "a&#92;b"]) expect([s, safeHref(s)]).toEqual([s, null]);
  });
});

describe("a tab after the quote marker", () => {
  test("counts as columns: one is the marker's space, the rest indent the content", () => {
    expect(types(">\t- a")).toContain("list");
    expect(JSON.stringify(doc(">\t\tcode"))).toContain('"value":"  code"');
    expect(types(">\ttext")).toEqual(types("> text"));
    expect(textOf(">\ttext")).toBe("text");
    expect(JSON.stringify(doc(" >\tx\n >\ty"))).toBe(JSON.stringify(doc(" > x\n > y")));
  });
});
