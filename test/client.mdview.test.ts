import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installDom, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let V: typeof import("../src/client/mdview.ts");
beforeAll(async () => {
  installDom();
  try {
    V = await import("../src/client/mdview.ts");
  } catch {}
});
afterAll(() => uninstallDom());

const SRC = "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nSome *text* here.\n";
const q = (v: { el: unknown }, sel: string) => (v.el as FakeElement).querySelectorAll<FakeElement>(sel);

describe("AC-2 MarkdownView renders the source as a document", () => {
  test("h1..h6 and p are built from the source", () => {
    const v = new V.MarkdownView(SRC);
    for (const [i, name] of ["One", "Two", "Three", "Four", "Five", "Six"].entries()) {
      const hs = q(v, "h" + (i + 1));
      expect(hs.length).toBe(1);
      expect(hs[0]!.textContent).toBe(name);
    }
    expect(q(v, "p").length).toBeGreaterThanOrEqual(1);
  });

  test("no pre of the raw source and no raw Markdown markers in text", () => {
    const v = new V.MarkdownView(SRC);
    expect(q(v, "pre").length).toBe(0);
    expect((v.el as FakeElement).textContent).not.toContain("# One");
    expect((v.el as FakeElement).textContent).toContain("One");
  });

  test("the container carries the md-view class", () => {
    const v = new V.MarkdownView("x");
    expect((v.el as FakeElement).classList.contains("md-view")).toBe(true);
  });

  test("empty text renders an empty tree without throwing", () => {
    const v = new V.MarkdownView("");
    expect(q(v, "p").length).toBe(0);
    expect(v.renders).toBe(1);
  });
});

describe("AC-4 live update", () => {
  test("new text replaces the tree and returns true", () => {
    const v = new V.MarkdownView("# Old");
    expect(v.setText("# New")).toBe(true);
    const hs = q(v, "h1");
    expect(hs.length).toBe(1);
    expect(hs[0]!.textContent).toBe("New");
    expect(v.renders).toBe(2);
  });

  test("scrollTop is preserved across a re-render", () => {
    const v = new V.MarkdownView(SRC);
    (v.el as FakeElement).scrollTop = 321;
    v.setText(SRC + "\nmore\n");
    expect((v.el as FakeElement).scrollTop).toBe(321);
  });

  test("identical text does not rebuild the tree", () => {
    const v = new V.MarkdownView(SRC);
    const first = (v.el as FakeElement).children[0];
    const n = v.renders;
    expect(v.setText(SRC)).toBe(false);
    expect(v.renders).toBe(n);
    expect((v.el as FakeElement).children[0]).toBe(first);
  });

  test("setFontSize and dispose do not throw, and a disposed view is emptied", () => {
    const v = new V.MarkdownView(SRC);
    v.setFontSize(18);
    expect((v.el as FakeElement).style["fontSize"] ?? (v.el as FakeElement).getAttribute("style") ?? "").toContain("18");
    v.dispose();
    expect(q(v, "h1").length).toBe(0);
  });
});

describe("AC-2 rendering is DOM-built, never HTML-parsed", () => {
  test("raw HTML in the source stays text", () => {
    const v = new V.MarkdownView("# <b>x</b>\n\n<script>y</script>");
    expect(q(v, "b").length).toBe(0);
    expect(q(v, "script").length).toBe(0);
    expect((v.el as FakeElement).textContent).toContain("<script>y</script>");
  });
});
