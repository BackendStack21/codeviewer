import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  installDom,
  uninstallDom,
  type FakeElement,
} from "./helpers/fakedom.ts";

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

const render = (src: string) =>
  R.renderMarkdown(M.parseMarkdown(src)) as unknown as FakeElement;
const q = (el: FakeElement, sel: string) =>
  el.querySelectorAll<FakeElement>(sel);
const fence = (lang: string, body: string) =>
  "```" + lang + "\n" + body + "\n```";
const allEls = (el: FakeElement): FakeElement[] => {
  const out: FakeElement[] = [el];
  const walk = (e: FakeElement) => {
    for (const c of e.children)
      if ("tag" in c) (out.push(c as FakeElement), walk(c as FakeElement));
  };
  walk(el);
  return out;
};
/** The code element inside the first pre (fakedom has no descendant selectors). */
const blockCode = (el: FakeElement) => q(q(el, "pre")[0]!, "code")[0]!;
const spans = (el: FakeElement) => q(el, "span");
const tokText = (el: FakeElement, tok: string) =>
  q(el, "span." + tok).map((s) => s.textContent);

describe("AC-18 highlighted fences", () => {
  test("a known language yields tok-* spans and the code text is unchanged", () => {
    const body = "const x = 1; // note";
    const el = render(fence("js", body));
    const code = blockCode(el);
    expect(code.textContent).toBe(body);
    expect(spans(code).length).toBeGreaterThan(0);
    expect(tokText(code, "tok-k")).toContain("const");
    expect(tokText(code, "tok-c").join("")).toContain("// note");
  });

  test("every span carries only a tok-<letter> class and no other attribute", () => {
    const el = render(
      fence(
        "ts",
        "export function f(a: number): string { return `x${a}` + 'y'; }",
      ),
    );
    const ss = spans(el);
    expect(ss.length).toBeGreaterThan(2);
    for (const s of ss) {
      expect(s.className).toMatch(/^tok-[a-z]$/);
      expect([...s.attrs.keys()]).toEqual(["class"]);
    }
  });

  test("lexer state is threaded line to line (block comment spanning lines)", () => {
    const el = render(fence("js", "/* open\nstill comment\nend */ let y"));
    const comments = tokText(el, "tok-c");
    expect(comments.join("|")).toContain("still comment");
    expect(comments.join("|")).toContain("end */");
    expect(blockCode(el).textContent).toBe(
      "/* open\nstill comment\nend */ let y",
    );
    expect(tokText(el, "tok-k")).toContain("let");
  });

  test("state does not leak between separate fences", () => {
    const el = render(
      fence("js", "/* never closed") + "\n\n" + fence("js", "let z = 2"),
    );
    const codes = q(el, "pre").map((p) => q(p, "code")[0]!);
    expect(codes.length).toBe(2);
    expect(tokText(codes[1]!, "tok-k")).toContain("let");
    expect(tokText(codes[1]!, "tok-c")).toEqual([]);
  });

  test("language keys map through the lexer's known languages (ts, py)", () => {
    expect(
      tokText(render(fence("ts", "const a: number = 1")), "tok-k"),
    ).toContain("const");
    expect(
      tokText(render(fence("py", "def f():\n    return 1")), "tok-k"),
    ).toContain("def");
  });

  test("the info string is never emitted into an attribute", () => {
    const el = render(fence("js", "let a = 1"));
    for (const e of allEls(el))
      for (const v of e.attrs.values()) expect(v).not.toMatch(/js|lang/i);
  });

  test("an unknown language renders plain text with no spans", () => {
    const el = render(fence("nosuchlang", "let a = 1; // x"));
    const code = blockCode(el);
    expect(code.textContent).toBe("let a = 1; // x");
    expect(spans(code).length).toBe(0);
  });

  test("an unsafe info string gives plain text and nothing in attributes", () => {
    const el = render('```"><script>alert(1)\nlet a = 1\n```');
    const code = blockCode(el);
    expect(code.textContent).toBe("let a = 1");
    expect(spans(code).length).toBe(0);
    expect(q(el, "script").length).toBe(0);
    for (const e of allEls(el))
      for (const v of e.attrs.values()) expect(v).not.toMatch(/script|[<>"]/);
  });

  test("a key longer than 20 characters or with other characters is not a lookup", () => {
    for (const lang of ["j".repeat(21), "js.x", "js$", "j s"]) {
      const el = render(fence(lang, "let a = 1"));
      expect(spans(el).length).toBe(0);
    }
  });

  test("a fence without an info string and an indented block stay plain", () => {
    expect(spans(render(fence("", "let a = 1"))).length).toBe(0);
    expect(spans(render("    let a = 1")).length).toBe(0);
  });

  test("fences of 2,000 lines are highlighted, 2,001 lines are plain", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, () => "let a = 1;").join("\n");
    const hi = render(fence("js", mk(2000)));
    expect(spans(hi).length).toBeGreaterThan(0);
    const lo = render(fence("js", mk(2001)));
    expect(spans(lo).length).toBe(0);
    expect(blockCode(lo).textContent).toBe(mk(2001));
  });

  test("fences over 200 KB are plain, just under are highlighted", () => {
    const line = "let a = 1; ".repeat(18).trimEnd(); // ~197 chars
    const mk = (n: number) => Array.from({ length: n }, () => line).join("\n");
    const under = mk(1000); // ~197 KB
    const over = mk(1040); // ~205 KB
    expect(under.length).toBeLessThan(200 * 1024);
    expect(over.length).toBeGreaterThan(200 * 1024);
    expect(spans(render(fence("js", under))).length).toBeGreaterThan(0);
    const plain = render(fence("js", over));
    expect(spans(plain).length).toBe(0);
    expect(blockCode(plain).textContent).toBe(over);
  });
});

describe("AC-19 Trojan Source escapes in rendered code", () => {
  test("code spans show controls and bidi overrides as visible escapes", () => {
    const el = render("see `a‮b\u0001c` here");
    const code = q(el, "code")[0]!;
    expect(code.textContent).toBe("a\\u202eb\\x01c");
  });

  test("fenced code blocks (plain) show escapes, no raw characters remain", () => {
    const el = render(fence("", "x‮y\u0085z⁦"));
    const t = blockCode(el).textContent;
    expect(t).toBe("x\\u202ey\\x85z\\u2066");
    expect(t).not.toMatch(/[‮\u0085⁦]/);
  });

  test("highlighted fences show escapes too", () => {
    const el = render(fence("js", "let a = '‮'; // ⁧\u0001"));
    const t = blockCode(el).textContent;
    expect(t).toBe("let a = '\\u202e'; // \\u2067\\x01");
    expect(spans(el).length).toBeGreaterThan(0);
  });

  test("indented code blocks show escapes", () => {
    const el = render("    a‮b");
    expect(blockCode(el).textContent).toBe("a\\u202eb");
  });

  test("link titles show escapes", () => {
    const el = render('[a](https://x.y/ "t‮e\u0001")');
    const a = q(el, "a")[0]!;
    expect(a.attrs.get("title")).toBe("t\\u202ee\\x01");
  });

  test("code blocks carry dir=auto", () => {
    const el = render(fence("", "abc"));
    const pre = q(el, "pre")[0]!;
    expect(pre.attrs.get("dir") ?? q(pre, "code")[0]!.attrs.get("dir")).toBe(
      "auto",
    );
  });

  test("ordinary text is untouched", () => {
    const el = render("`héllo ✓` and\n\n" + fence("", "日本 ok"));
    expect(q(el, "code")[0]!.textContent).toBe("héllo ✓");
    expect(blockCode(el).textContent).toBe("日本 ok");
  });
});
