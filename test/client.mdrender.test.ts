import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installDom, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

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

const render = (src: string) => R.renderMarkdown(M.parseMarkdown(src)) as unknown as FakeElement;
const q = (el: FakeElement, sel: string) => el.querySelectorAll<FakeElement>(sel);
const names = (el: FakeElement): string[] => {
  const out: string[] = [];
  const walk = (e: FakeElement) => {
    for (const c of e.children) if ("tag" in c) (out.push(c.tag), walk(c));
  };
  walk(el);
  return out;
};

describe("block rendering", () => {
  test("block quote", () => {
    const el = render("> a\n>\n> > b");
    expect(q(el, "blockquote").length).toBe(2);
  });

  test("bullet list is ul/li, ordered list is ol with a start attribute only when not 1", () => {
    expect(q(render("- a\n- b"), "ul").length).toBe(1);
    expect(q(render("- a\n- b"), "li").length).toBe(2);
    const ol3 = q(render("3. a\n4. b"), "ol")[0]!;
    expect(ol3.getAttribute("start")).toBe("3");
    expect(q(render("1. a"), "ol")[0]!.getAttribute("start")).toBeNull();
  });

  test("a tight list has no p inside li; a loose list does", () => {
    expect(q(render("- a\n- b"), "p").length).toBe(0);
    expect(q(render("- a\n\n- b"), "p").length).toBe(2);
    expect(q(render("- a\n- b"), "li")[0]!.textContent).toBe("a");
  });

  test("nested lists nest in the DOM", () => {
    const el = render("- a\n  - b\n- c");
    expect(q(el, "ul").length).toBe(2);
    expect(q(q(el, "li")[0]!, "ul").length).toBe(1);
  });

  test("code block is pre > code and keeps the text verbatim", () => {
    const el = render("```js\nlet <x> = 1;\n  y\n```");
    const pre = q(el, "pre");
    expect(pre.length).toBe(1);
    expect(q(pre[0]!, "code").length).toBe(1);
    expect(pre[0]!.textContent).toBe("let <x> = 1;\n  y");
  });

  test("thematic break", () => {
    expect(q(render("a\n\n***\n\nb"), "hr").length).toBe(1);
  });
});

describe("inline rendering", () => {
  test("em, strong, code, br", () => {
    const el = render("*a* **b** `c` d  \ne");
    expect(q(el, "em")[0]!.textContent).toBe("a");
    expect(q(el, "strong")[0]!.textContent).toBe("b");
    expect(q(el, "code")[0]!.textContent).toBe("c");
    expect(q(el, "br").length).toBe(1);
  });

  test("entities appear as text", () => {
    const el = render("&lt;b&gt; &amp;");
    expect(el.textContent).toBe("<b> &");
    expect(q(el, "b").length).toBe(0);
  });

  test("backslash escapes produce no emphasis", () => {
    const el = render("\\*a\\*");
    expect(q(el, "em").length).toBe(0);
    expect(el.textContent).toBe("*a*");
  });
});

describe("AC-8 raw HTML is text", () => {
  const BAD = ["script", "img", "b", "div", "iframe", "style", "a", "i"];
  test.each([
    "<script>x</script>",
    "<img onerror=x>",
    "<!-- c -->",
    "<b>x</b>",
    "<div>\nhello\n</div>",
    "a <i>b</i> c",
    "<a href=\"javascript:alert(1)\">x</a>",
  ])("%s", (src) => {
    const el = render(src);
    for (const tag of BAD) expect(q(el, tag).length).toBe(0);
    expect(names(el).every((t) => !BAD.includes(t))).toBe(true);
    expect(el.textContent.replace(/\s+/g, "")).toContain(src.split("\n")[0]!.replace(/\s+/g, "").slice(0, 4));
  });

  test("the characters are shown literally, and Markdown inside still renders as Markdown", () => {
    const el = render("<b>*x*</b>");
    expect(el.textContent).toBe("<b>x</b>");
    expect(q(el, "em").length).toBe(1);
    expect(q(el, "b").length).toBe(0);
  });

  test("a script tag keeps its angle brackets", () => {
    expect(render("<script>x</script>").textContent).toBe("<script>x</script>");
  });

  test("an HTML comment is shown", () => {
    expect(render("<!-- c -->").textContent).toBe("<!-- c -->");
  });
});

describe("AC-10 node cap", () => {
  const para = (i: number) => ({ type: "paragraph", children: [{ type: "text", value: "p" + i }] });
  const many = (n: number) => Array.from({ length: n }, (_, i) => para(i)) as never;

  test("above 200,000 nodes rendering stops with a notice", () => {
    const el = R.renderMarkdown(many(250_000)) as unknown as FakeElement;
    const notice = q(el, ".md-truncated");
    expect(notice.length).toBe(1);
    expect(notice[0]!.textContent).toBe("Preview truncated, view source");
    const rendered = q(el, "p").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThanOrEqual(200_000);
  });

  test("the notice is the last child", () => {
    const el = R.renderMarkdown(many(250_000)) as unknown as FakeElement;
    const last = el.children[el.children.length - 1] as FakeElement;
    expect(last.classList.contains("md-truncated")).toBe(true);
  });

  test("under the cap there is no notice and everything renders", () => {
    const el = R.renderMarkdown(many(1000)) as unknown as FakeElement;
    expect(q(el, ".md-truncated").length).toBe(0);
    expect(q(el, "p").length).toBe(1000);
  });
});
