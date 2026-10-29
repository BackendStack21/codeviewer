import { describe, expect, test } from "bun:test";
import { parseMarkdown, resolveRepoPath, safeHref, slugify, type Inline, type Block } from "../src/client/markdown.ts";

describe("AC-11 safeHref", () => {
  const rejected: [string, string][] = [
    ["javascript plain", "javascript:alert(1)"],
    ["mixed case", "JaVaScRiPt:alert(1)"],
    ["tab inside", "java\tscript:alert(1)"],
    ["newline inside", "java\nscript:alert(1)"],
    ["hex entity", "&#x6A;avascript:alert(1)"],
    ["decimal entity", "&#106;avascript:alert(1)"],
    ["entity newline", "java&#10;script:alert(1)"],
    ["leading control", "\u0001javascript:alert(1)"],
    ["leading space", "  javascript:alert(1)"],
    ["zero width space", "jav\u200Bascript:alert(1)"],
    ["zero width joiner", "java\u200Dscript:alert(1)"],
    ["bom", "\uFEFFjavascript:alert(1)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["data upper", "DATA:text/html;base64,AAAA"],
    ["vbscript", "vbscript:msgbox(1)"],
    ["file", "file:///etc/passwd"],
    ["blob", "blob:http://127.0.0.1/abc"],
    ["protocol relative", "//evil.example/x"],
    ["backslash host", "\\\\evil.example\\x"],
    ["slash backslash", "/\\evil.example"],
    ["backslash path", "a\\b.md"],
    ["ftp", "ftp://x.y/z"],
    ["tel", "tel:123"],
    ["about", "about:blank"],
    ["unknown scheme", "x-custom:foo"],
    ["empty", ""],
    ["only spaces", "   "],
  ];
  for (const [name, url] of rejected) {
    test("rejects " + name, () => {
      expect(safeHref(url)).toBeNull();
    });
  }

  test("accepts http, https and mailto as external", () => {
    expect(safeHref("http://a.b/c?d=1#e")).toEqual({ kind: "external", href: "http://a.b/c?d=1#e" });
    expect(safeHref("https://a.b")).toEqual({ kind: "external", href: "https://a.b" });
    expect(safeHref("HTTPS://A.B/x")?.kind).toBe("external");
    expect(safeHref("mailto:a@b.co")).toEqual({ kind: "external", href: "mailto:a@b.co" });
  });

  test("accepts a fragment", () => {
    expect(safeHref("#x")).toEqual({ kind: "fragment", href: "#x" });
    expect(safeHref("#heading-1")?.kind).toBe("fragment");
  });

  test("accepts relative paths as repo", () => {
    expect(safeHref("a/b.md")).toEqual({ kind: "repo", href: "a/b.md" });
    expect(safeHref("./a.md")?.kind).toBe("repo");
    expect(safeHref("../a.md#sec")?.kind).toBe("repo");
    expect(safeHref("/docs/a.md")?.kind).toBe("repo");
    expect(safeHref("a.md?x=1")?.kind).toBe("repo");
  });

  test("a colon after the first slash is not a scheme", () => {
    expect(safeHref("a/b:c.md")?.kind).toBe("repo");
  });

  test("never throws on junk", () => {
    for (const s of ["%", "%zz", "&#xZZ;", "&#99999999999;", "\0", "a".repeat(100000), ":", "::::"]) {
      expect(() => safeHref(s)).not.toThrow();
    }
  });
});

describe("AC-12 resolveRepoPath", () => {
  const r = (base: string, rel: string) => resolveRepoPath(base, rel);

  test("plain relative paths join the base folder", () => {
    expect(r("docs", "a.md")).toEqual({ path: "docs/a.md", query: "", hash: "" });
    expect(r("", "a.md")).toEqual({ path: "a.md", query: "", hash: "" });
    expect(r("docs", "./a")?.path).toBe("docs/a");
    expect(r("a/b", "c/../d.md")?.path).toBe("a/b/d.md");
    expect(r("a", "b//c/./d")?.path).toBe("a/b/c/d");
  });

  test("dot-dot climbs and may reach the root but not beyond", () => {
    expect(r("docs", "../x")?.path).toBe("x");
    expect(r("a/b", "../../etc/passwd")?.path).toBe("etc/passwd");
    expect(r("docs", "../../etc/passwd")).toBeNull();
    expect(r("", "../x")).toBeNull();
    expect(r("a", "../../x")).toBeNull();
  });

  test("a leading slash means the repo root", () => {
    expect(r("docs", "/a")?.path).toBe("a");
    expect(r("a/b", "/c/d.md")?.path).toBe("c/d.md");
    expect(r("docs", "/../a")).toBeNull();
  });

  test("percent encoding is decoded exactly once", () => {
    expect(r("docs", "%2e%2e/x")?.path).toBe("x");
    expect(r("", "%2e%2e/x")).toBeNull();
    expect(r("docs", "a%20b.md")?.path).toBe("docs/a b.md");
    expect(r("docs", "%252e%252e/x")?.path).toBe("docs/%2e%2e/x");
    expect(r("docs", "%252e")?.path).toBe("docs/%2e");
  });

  test("query and fragment are split off", () => {
    expect(r("", "docs/b.md?x#y")).toEqual({ path: "docs/b.md", query: "x", hash: "y" });
    expect(r("", "b.md#sec")).toEqual({ path: "b.md", query: "", hash: "sec" });
    expect(r("", "b.md?q=1")).toEqual({ path: "b.md", query: "q=1", hash: "" });
    expect(r("docs", "../x?y")).toEqual({ path: "x", query: "y", hash: "" });
  });

  test("a dot-dot hidden before the query does not escape", () => {
    expect(r("", "..?x")).toBeNull();
    expect(r("", "../?x#y")).toBeNull();
  });

  test("backslashes are rejected", () => {
    expect(r("", "a/..\\..\\b")).toBeNull();
    expect(r("docs", "a\\b")).toBeNull();
    expect(r("docs", "%5Cb")).toBeNull();
  });

  test("NUL and control characters are rejected", () => {
    expect(r("", "a\0b")).toBeNull();
    expect(r("", "a%00b")).toBeNull();
    expect(r("", "a\nb")).toBeNull();
  });

  test("drive letters and schemes are rejected", () => {
    expect(r("", "C:\\x")).toBeNull();
    expect(r("", "C:/x")).toBeNull();
    expect(r("", "http://x.y/z")).toBeNull();
  });

  test("empty and invalid input returns null or a path without throwing", () => {
    expect(r("", "")).toBeNull();
    expect(() => r("", "%zz")).not.toThrow();
    expect(() => r("", "%E0%A4%A")).not.toThrow();
    expect(() => r("a", "x".repeat(100000))).not.toThrow();
  });
});

describe("slugify", () => {
  test("GitHub style", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Some   Title  ")).toBe("some-title");
    expect(slugify("A_b-c d")).toBe("a_b-c-d");
    expect(slugify("Café au lait")).toBe("café-au-lait");
    expect(slugify("API (v2) `code`")).toBe("api-v2-code");
  });

  test("duplicates get -1, -2", () => {
    const seen = new Map<string, number>();
    expect(slugify("Hello", seen)).toBe("hello");
    expect(slugify("Hello", seen)).toBe("hello-1");
    expect(slugify("hello", seen)).toBe("hello-2");
    expect(slugify("Other", seen)).toBe("other");
  });

  test("an empty title yields a stable non-empty-or-empty string without throwing", () => {
    expect(() => slugify("!!!")).not.toThrow();
    expect(typeof slugify("")).toBe("string");
  });
});

describe("AC-14 autolinks in the AST", () => {
  const links = (src: string): Extract<Inline, { type: "link" }>[] => {
    const out: Extract<Inline, { type: "link" }>[] = [];
    const walkI = (list: Inline[]) => {
      for (const n of list) {
        if (n.type === "link") out.push(n);
        if (n.type === "link" || n.type === "em" || n.type === "strong") walkI(n.children);
      }
    };
    const walkB = (list: Block[]) => {
      for (const b of list) {
        if (b.type === "paragraph" || b.type === "heading") walkI(b.children);
        else if (b.type === "blockquote") walkB(b.children);
        else if (b.type === "list") for (const it of b.items) walkB(it.children);
      }
    };
    walkB(parseMarkdown(src));
    return out;
  };
  const label = (l: { children: Inline[] }) => l.children.map((c) => (c.type === "text" ? c.value : "")).join("");

  test("angle-bracket URL autolink", () => {
    const l = links("see <https://x.y/z> now");
    expect(l.length).toBe(1);
    expect(l[0]!.href).toBe("https://x.y/z");
    expect(label(l[0]!)).toBe("https://x.y/z");
  });

  test("angle-bracket email autolink becomes mailto", () => {
    const l = links("<a@b.co>");
    expect(l.length).toBe(1);
    expect(l[0]!.href).toBe("mailto:a@b.co");
    expect(label(l[0]!)).toBe("a@b.co");
  });

  test("bare URL autolink", () => {
    const l = links("go to https://x.y/z today");
    expect(l.length).toBe(1);
    expect(l[0]!.href).toBe("https://x.y/z");
    expect(label(l[0]!)).toBe("https://x.y/z");
  });

  test("bare http URL excludes trailing punctuation and unbalanced paren", () => {
    expect(links("Visit http://x.y/a.")[0]?.href).toBe("http://x.y/a");
    expect(links("(https://x.y/a)")[0]?.href).toBe("https://x.y/a");
    expect(links("https://x.y/a, and")[0]?.href).toBe("https://x.y/a");
    expect(links("https://x.y/a_(b)")[0]?.href).toBe("https://x.y/a_(b)");
  });

  test("a bare URL is linked inside emphasis and list items", () => {
    expect(links("*https://x.y*").length).toBe(1);
    expect(links("- https://x.y").length).toBe(1);
  });

  test("not linked inside code spans or an explicit link label", () => {
    expect(links("`https://x.y`").length).toBe(0);
    const l = links("[https://x.y](https://q.r)");
    expect(l.length).toBe(1);
    expect(l[0]!.href).toBe("https://q.r");
  });

  test("a scheme-only or non-http bare string is not linked", () => {
    expect(links("https:// nothing").length).toBe(0);
    expect(links("javascript:alert(1) and ftp://x.y").length).toBe(0);
  });

  test("explicit and reference links keep the raw href in the AST", () => {
    expect(links("[a](b/c.md)")[0]?.href).toBe("b/c.md");
    expect(links("[a][r]\n\n[r]: https://x.y")[0]?.href).toBe("https://x.y");
  });
});
