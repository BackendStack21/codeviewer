import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, uninstallDom, type Dom, type FakeElement } from "./helpers/fakedom.ts";

let M: typeof import("../src/client/markdown.ts");
let R: typeof import("../src/client/mdrender.ts");
let V: typeof import("../src/client/mdview.ts");
let dom: Dom;
beforeAll(async () => {
  dom = installDom({ hash: "#orig" });
  try {
    M = await import("../src/client/markdown.ts");
    R = await import("../src/client/mdrender.ts");
    V = await import("../src/client/mdview.ts");
  } catch {}
});
afterAll(() => uninstallDom());

const render = (src: string, base = "") => R.renderMarkdown(M.parseMarkdown(src), { base }) as unknown as FakeElement;
const q = (el: FakeElement, sel: string) => el.querySelectorAll<FakeElement>(sel);
const one = (el: FakeElement, sel: string) => {
  const r = q(el, sel);
  expect(r.length).toBeGreaterThan(0);
  return r[0]!;
};
const text = (e: FakeElement) => e.textContent;
const click = (el: FakeElement) => {
  const ev = new FakeEvent("click", { button: 0 });
  el.dispatchEvent(ev);
  return ev;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AC-13 external links", () => {
  test("http, https and mailto links carry rel and target", () => {
    const el = render("[a](http://x.y) [b](https://x.y/z) [c](mailto:a@b.co)");
    const as = q(el, "a");
    expect(as.length).toBe(3);
    for (const a of as) {
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
      expect(a.getAttribute("target")).toBe("_blank");
    }
    expect(as[0]!.getAttribute("href")).toBe("http://x.y");
    expect(text(as[1]!)).toBe("b");
  });

  test("link title becomes the title attribute", () => {
    const a = one(render('[a](https://x.y "Tip")'), "a");
    expect(a.getAttribute("title")).toBe("Tip");
  });

  test("disallowed schemes render as plain label text with no anchor", () => {
    for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "blob:http://x/y", "//evil.example/x", "&#x6A;avascript:alert(1)"]) {
      const el = render(`[label](${url})`);
      expect(q(el, "a").length).toBe(0);
      expect(text(el)).toContain("label");
    }
  });

  test("a disallowed autolink renders no anchor", () => {
    expect(q(render("<javascript:alert(1)>"), "a").length).toBe(0);
  });

  test("no href anywhere contains a raw disallowed scheme", () => {
    const el = render("[a](java\tscript:x) [b](https://ok.example) [c](x-foo:bar)");
    for (const a of q(el, "a")) expect(a.getAttribute("href")).toMatch(/^(https?:|mailto:|#|[^:]*$)/);
  });
});

describe("AC-14 autolinks render", () => {
  test("bare URL and angle autolink are safe external links", () => {
    const el = render("see https://x.y/z and <https://q.r>");
    const as = q(el, "a");
    expect(as.length).toBe(2);
    for (const a of as) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    }
    expect(as[0]!.getAttribute("href")).toBe("https://x.y/z");
    expect(as[1]!.getAttribute("href")).toBe("https://q.r");
  });
});

describe("AC-13 repo links", () => {
  test("a relative link is resolved against the document folder", () => {
    const a = one(render("[d](../other/b.md#sec)", "docs/sub"), "a");
    expect(a.getAttribute("data-md-path")).toBe("docs/other/b.md");
    expect(a.getAttribute("data-md-hash")).toBe("sec");
    expect(a.getAttribute("target")).toBeNull();
  });

  test("a link that escapes the root renders as plain text", () => {
    const el = render("[x](../../../etc/passwd)", "docs");
    expect(q(el, "a").length).toBe(0);
    expect(text(el)).toContain("x");
  });

  test("href never contains the raw path of an API endpoint", () => {
    const el = render("[x](a.md) [y](/api/raw?path=.env)", "");
    for (const a of q(el, "a")) expect(a.getAttribute("href") ?? "").not.toContain("/api/");
  });

  test("clicking calls onOpen with the resolved path and hash and prevents default", () => {
    const calls: [string, string][] = [];
    const v = new V.MarkdownView("[d](b.md#sec)", 13, { path: "docs/a.md", onOpen: (p, h) => void calls.push([p, h]) });
    const a = one(v.el as FakeElement, "a");
    const ev = click(a);
    expect(ev.defaultPrevented).toBe(true);
    expect(calls).toEqual([["docs/b.md", "sec"]]);
  });

  test("clicking a link label nested in emphasis still opens", () => {
    const calls: string[] = [];
    const v = new V.MarkdownView("[*em*](x.md)", 13, { path: "a.md", onOpen: (p) => void calls.push(p) });
    click(one(v.el as FakeElement, "em"));
    expect(calls).toEqual(["x.md"]);
  });

  test("a missing target shows a File not found notice", async () => {
    const v = new V.MarkdownView("[d](gone.md)", 13, { path: "a.md", onOpen: () => false });
    click(one(v.el as FakeElement, "a"));
    await tick();
    expect((v.el as FakeElement).textContent).toContain("File not found");
    const v2 = new V.MarkdownView("[d](gone.md)", 13, { path: "a.md", onOpen: async () => false });
    click(one(v2.el as FakeElement, "a"));
    await tick();
    expect((v2.el as FakeElement).textContent).toContain("File not found");
  });

  test("a found target shows no notice", async () => {
    const v = new V.MarkdownView("[d](here.md)", 13, { path: "a.md", onOpen: async () => true });
    click(one(v.el as FakeElement, "a"));
    await tick();
    expect((v.el as FakeElement).textContent).not.toContain("File not found");
  });

  test("external links are not intercepted", () => {
    const calls: string[] = [];
    const v = new V.MarkdownView("[x](https://x.y)", 13, { path: "a.md", onOpen: (p) => void calls.push(p) });
    const ev = click(one(v.el as FakeElement, "a"));
    expect(calls).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
  });

  test("clicking non-link content does nothing", () => {
    const calls: string[] = [];
    const v = new V.MarkdownView("# T\n\ntext", 13, { path: "a.md", onOpen: (p) => void calls.push(p) });
    const ev = click(one(v.el as FakeElement, "p"));
    expect(calls).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
  });

  test("a document without a path resolves against the root", () => {
    const calls: string[] = [];
    const v = new V.MarkdownView("[d](b.md)", 13, { onOpen: (p) => void calls.push(p) });
    click(one(v.el as FakeElement, "a"));
    expect(calls).toEqual(["b.md"]);
  });
});

describe("AC-13 fragments", () => {
  const SRC = "# Intro\n\n## Hello World\n\ntext\n\n## Hello World\n\n[go](#hello-world) [go2](#hello-world-1)\n";

  test("headings get md- prefixed GitHub style ids, duplicates -1", () => {
    const el = render(SRC);
    const ids = q(el, "h1,h2").map((h) => h.getAttribute("id"));
    expect(ids).toEqual(["md-intro", "md-hello-world", "md-hello-world-1"]);
  });

  test("every id in the tree is md- prefixed", () => {
    const el = render(SRC + "\n- a\n- b\n\n> q\n");
    const walk = (e: FakeElement) => {
      for (const c of e.children) {
        if (!("tag" in c)) continue;
        const id = c.getAttribute("id");
        if (id !== null) expect(id.startsWith("md-")).toBe(true);
        walk(c);
      }
    };
    walk(el);
  });

  test("a fragment link keeps its #href and has no target or rel", () => {
    const a = one(render(SRC), "a");
    expect(a.getAttribute("href")).toBe("#hello-world");
    expect(a.getAttribute("target")).toBeNull();
  });

  test("clicking scrolls to the heading and never touches location.hash", () => {
    const v = new V.MarkdownView(SRC, 13, { path: "a.md" });
    const heads = q(v.el as FakeElement, "h2");
    expect(heads.length).toBe(2);
    const links = q(v.el as FakeElement, "a");
    expect(links.length).toBe(2);
    const [link1, link2] = links;
    const before = dom.location.hash;
    const calls = dom.history.calls.length;
    const ev = click(link1!);
    expect(ev.defaultPrevented).toBe(true);
    expect(heads[0]!.scrolled).toBe(1);
    expect(heads[1]!.scrolled).toBe(0);
    click(link2!);
    expect(heads[1]!.scrolled).toBe(1);
    expect(dom.location.hash).toBe(before);
    expect(dom.history.calls.length).toBe(calls);
  });

  test("a fragment with no matching heading is prevented and harmless", () => {
    const v = new V.MarkdownView("[x](#nope)\n\n# T", 13, { path: "a.md" });
    const ev = click(one(v.el as FakeElement, "a"));
    expect(ev.defaultPrevented).toBe(true);
    expect(dom.location.hash).toBe("#orig");
  });

  test("fragment link matching is case-insensitive like GitHub slugs", () => {
    const v = new V.MarkdownView("# Title\n\n[x](#Title)", 13, { path: "a.md" });
    click(one(v.el as FakeElement, "a"));
    expect(one(v.el as FakeElement, "h1").scrolled).toBe(1);
  });
});
