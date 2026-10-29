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

const q = (el: unknown, sel: string) => (el as FakeElement).querySelectorAll<FakeElement>(sel);
const click = (el: FakeElement) => {
  const ev = new FakeEvent("click", { button: 0 });
  el.dispatchEvent(ev);
  return ev;
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const text = (v: { el: unknown }) => (v.el as FakeElement).textContent;

describe("carried (a): [x](other.md#section) opens the file and scrolls to the heading", () => {
  test("the click hands the fragment to onOpen", () => {
    const calls: [string, string][] = [];
    const v = new V.MarkdownView("[x](other.md#section)", 13, { path: "docs/a.md", onOpen: (p, h) => void calls.push([p, h]) });
    click(q(v.el, "a")[0]!);
    expect(calls).toEqual([["docs/other.md", "section"]]);
  });

  test("scrollToFragment scrolls to the matching heading and reports it", () => {
    const v = new V.MarkdownView("# Top\n\n## Some Section\n\ntext", 13, { path: "o.md" });
    expect(v.scrollToFragment("some-section")).toBe(true);
    expect(q(v.el, "h2")[0]!.scrolled).toBe(1);
    expect(q(v.el, "h1")[0]!.scrolled).toBe(0);
  });

  test("scrollToFragment slugifies the fragment (case, percent-encoding) and misses cleanly", () => {
    const v = new V.MarkdownView("# C++ & Go!\n\n## Other", 13, { path: "o.md" });
    expect(v.scrollToFragment("C++%20&%20Go!")).toBe(true);
    expect(v.scrollToFragment("OTHER")).toBe(true);
    expect(v.scrollToFragment("nope")).toBe(false);
    expect(v.scrollToFragment("")).toBe(false);
  });

  test("a hash option scrolls once the document is built", () => {
    const v = new V.MarkdownView("# A\n\n## Target Heading\n", 13, { path: "o.md", hash: "target-heading" });
    expect(q(v.el, "h2")[0]!.scrolled).toBe(1);
  });

  test("an unknown hash option is harmless", () => {
    const v = new V.MarkdownView("# A", 13, { path: "o.md", hash: "zzz" });
    expect(q(v.el, "h1")[0]!.scrolled).toBe(0);
  });
});

describe("carried (b): in-page fragment clicks use slugify", () => {
  const SRC = "# C++ & Go!\n\n[a](#C++%20&%20Go!) [b](<#C++ & Go!>) [c](#c-go)\n";

  test("the heading id is md-c-go", () => {
    expect(q(R.renderMarkdown(M.parseMarkdown(SRC), {}), "h1")[0]!.getAttribute("id")).toBe("md-c-go");
  });

  test("clicking #C++ & Go! (encoded or angle-bracketed) or #c-go finds that heading", () => {
    const v = new V.MarkdownView(SRC, 13, { path: "a.md" });
    const h = q(v.el, "h1")[0]!;
    const links = q(v.el, "a");
    expect(links.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      const ev = click(links[i]!);
      expect(ev.defaultPrevented).toBe(true);
      expect(h.scrolled).toBe(i + 1);
    }
    expect(dom.location.hash).toBe("#orig");
  });

  test("duplicate headings still resolve by their suffixed slug", () => {
    const v = new V.MarkdownView("# Go!\n\n# Go!\n\n[x](#go-1)", 13, { path: "a.md" });
    click(q(v.el, "a")[0]!);
    const hs = q(v.el, "h1");
    expect(hs[1]!.scrolled).toBe(1);
    expect(hs[0]!.scrolled).toBe(0);
  });
});

describe("carried (c): the File not found notice clears", () => {
  const SRC = "[gone](gone.md) [here](here.md) [jump](#t)\n\n# T\n";
  const setup = () => {
    const open = async (p: string) => p !== "gone.md";
    const v = new V.MarkdownView(SRC, 13, { path: "a.md", onOpen: open });
    const link = (label: string) => q(v.el, "a").find((a) => a.textContent === label)!;
    return { v, link };
  };

  test("shows on a failed open", async () => {
    const { v, link } = setup();
    click(link("gone"));
    await tick();
    expect(text(v)).toContain("File not found");
  });

  test("clears on the next successful open", async () => {
    const { v, link } = setup();
    click(link("gone"));
    await tick();
    click(link("here"));
    await tick();
    expect(text(v)).not.toContain("File not found");
    expect(q(v.el, ".md-notice").length).toBe(0);
  });

  test("clears on an in-page fragment click", async () => {
    const { v, link } = setup();
    click(link("gone"));
    await tick();
    click(link("jump"));
    await tick();
    expect(q(v.el, ".md-notice").length).toBe(0);
  });

  test("repeated failures show a single notice", async () => {
    const { v, link } = setup();
    click(link("gone"));
    await tick();
    click(link("gone"));
    await tick();
    expect(q(v.el, ".md-notice").length).toBe(1);
  });

  test("clears when the document re-renders", async () => {
    const { v, link } = setup();
    click(link("gone"));
    await tick();
    v.setText(SRC + "more\n");
    expect(q(v.el, ".md-notice").length).toBe(0);
  });
});

describe("carried (d): a task item with only the marker renders a checkbox", () => {
  const boxes = (src: string) => q(R.renderMarkdown(M.parseMarkdown(src), {}), "input");

  test("- [x] alone is a checked disabled checkbox", () => {
    const b = boxes("- [x]");
    expect(b.length).toBe(1);
    expect(b[0]!.getAttribute("type")).toBe("checkbox");
    expect(b[0]!.attrs.has("disabled")).toBe(true);
    expect(b[0]!.attrs.has("checked")).toBe(true);
  });

  test("- [ ] alone is an unchecked disabled checkbox; X is also checked", () => {
    const u = boxes("- [ ]");
    expect(u.length).toBe(1);
    expect(u[0]!.attrs.has("checked")).toBe(false);
    expect(u[0]!.attrs.has("disabled")).toBe(true);
    expect(boxes("- [X]")[0]!.attrs.has("checked")).toBe(true);
  });

  test("marker-only items among others keep the order and show no marker text", () => {
    const el = R.renderMarkdown(M.parseMarkdown("- [x]\n- [ ]\n- [x] done\n"), {});
    const b = q(el, "input");
    expect(b.map((x) => x.attrs.has("checked"))).toEqual([true, false, true]);
    expect((el as unknown as FakeElement).textContent).not.toContain("[x]");
    expect((el as unknown as FakeElement).textContent).not.toContain("[ ]");
  });

  test("the parser marks the item checked", () => {
    const blocks = M.parseMarkdown("- [x]");
    const list = blocks[0] as Extract<(typeof blocks)[number], { type: "list" }>;
    expect(list.items[0]!.checked).toBe(true);
  });

  test("the marker followed by text without a space is still plain text", () => {
    expect(boxes("- [x]a").length).toBe(0);
  });
});
