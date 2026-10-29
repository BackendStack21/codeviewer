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

const TABLE = "| Name | Qty | Note |\n|:-----|:---:|-----:|\n| a | 1 | x \\| y |\n| b | 2 | z |";

describe("AC-15 table rendering", () => {
  test("produces a real table with thead and tbody", () => {
    const el = render(TABLE);
    expect(q(el, "table").length).toBe(1);
    expect(q(el, "thead").length).toBe(1);
    expect(q(el, "tbody").length).toBe(1);
    expect(q(q(el, "thead")[0]!, "th").length).toBe(3);
    expect(q(q(el, "tbody")[0]!, "tr").length).toBe(2);
    expect(q(q(el, "tbody")[0]!, "td").length).toBe(6);
    expect(q(q(el, "tbody")[0]!, "th").length).toBe(0);
  });

  test("cell text is rendered as text with the escaped pipe unescaped", () => {
    const tds = q(render(TABLE), "td");
    expect(tds[0]!.textContent).toBe("a");
    expect(tds[2]!.textContent).toBe("x | y");
  });

  test("alignment is carried by md-align-* classes on th and td", () => {
    const el = render(TABLE);
    const ths = q(el, "th");
    expect(ths[0]!.classList.contains("md-align-left")).toBe(true);
    expect(ths[1]!.classList.contains("md-align-center")).toBe(true);
    expect(ths[2]!.classList.contains("md-align-right")).toBe(true);
    const tds = q(el, "td");
    expect(tds[1]!.classList.contains("md-align-center")).toBe(true);
    expect(tds[5]!.classList.contains("md-align-right")).toBe(true);
  });

  test("an unaligned column has no md-align class", () => {
    const th = q(render("| a |\n| - |\n| 1 |"), "th")[0]!;
    expect(th.className).not.toContain("md-align");
  });

  test("no element in the table carries a style or align attribute", () => {
    const el = render(TABLE);
    for (const e of [...q(el, "table"), ...q(el, "thead"), ...q(el, "tbody"), ...q(el, "tr"), ...q(el, "th"), ...q(el, "td")]) {
      expect(e.attrs.has("style")).toBe(false);
      expect(e.attrs.has("align")).toBe(false);
      expect(Object.keys(e.style).length).toBe(0);
    }
  });

  test("inline syntax inside cells is rendered", () => {
    const el = render("| h |\n| - |\n| **b** `c` [l](https://x.y) |");
    const td = q(el, "td")[0]!;
    expect(q(td, "strong").length).toBe(1);
    expect(q(td, "code").length).toBe(1);
    expect(q(td, "a").length).toBe(1);
  });

  test("HTML in a cell stays text", () => {
    const el = render("| h |\n| - |\n| <script>x</script> |");
    expect(q(el, "script").length).toBe(0);
    expect(q(el, "td")[0]!.textContent).toBe("<script>x</script>");
  });

  test("a table inside a block quote still renders", () => {
    const bq = q(render("> | a |\n> | - |\n> | 1 |"), "blockquote")[0]!;
    expect(q(bq, "table").length).toBe(1);
  });

  test("more than 200 columns degrade to a paragraph, not a table", () => {
    const row = (n: number, c: string) => "|" + Array.from({ length: n }, () => c).join("|") + "|";
    const el = render(`${row(201, " a ")}\n${row(201, "---")}\n${row(201, " b ")}`);
    expect(q(el, "table").length).toBe(0);
    expect(q(el, "p").length).toBe(1);
  });

  test("a table counts against the node budget", () => {
    const cells = 300;
    const head = "|" + Array.from({ length: 10 }, () => " h ").join("|") + "|";
    const sep = "|" + Array.from({ length: 10 }, () => "-").join("|") + "|";
    const body = Array.from({ length: cells }, () => "|" + Array.from({ length: 10 }, () => " c ").join("|") + "|").join("\n");
    const el = R.renderMarkdown(M.parseMarkdown(`${head}\n${sep}\n${body}`)) as unknown as FakeElement;
    expect(q(el, "td").length).toBe(cells * 10);
  });
});

describe("AC-16 task lists", () => {
  test("renders disabled checkboxes, checked state matching the source", () => {
    const el = render("- [x] a\n- [ ] b");
    const boxes = q(el, "input");
    expect(boxes.length).toBe(2);
    for (const b of boxes) {
      expect(b.getAttribute("type")).toBe("checkbox");
      expect(b.attrs.has("disabled")).toBe(true);
    }
    expect(boxes[0]!.attrs.has("checked")).toBe(true);
    expect(boxes[1]!.attrs.has("checked")).toBe(false);
  });

  test("checkboxes have no handlers and no on* attributes", () => {
    for (const b of q(render("- [x] a\n- [ ] b"), "input")) {
      expect(b.listenerCount("click")).toBe(0);
      expect(b.listenerCount("change")).toBe(0);
      expect(b.listenerCount("input")).toBe(0);
      for (const k of b.attrs.keys()) expect(k.startsWith("on")).toBe(false);
    }
  });

  test("the marker text is not rendered next to the checkbox", () => {
    const li = q(render("- [x] done"), "li")[0]!;
    expect(li.textContent).toBe("done");
  });

  test("plain items in the same list get no checkbox", () => {
    const el = render("- [x] a\n- plain");
    expect(q(el, "input").length).toBe(1);
    expect(q(el, "li")[1]!.textContent).toBe("plain");
  });

  test("a non-task item that merely looks like one has no checkbox", () => {
    expect(q(render("- [x]a\n- [] b"), "input").length).toBe(0);
  });

  test("a loose task item keeps the checkbox inside its li", () => {
    const el = render("- [ ] a\n\n- [x] b");
    expect(q(el, "li").length).toBe(2);
    expect(q(q(el, "li")[0]!, "input").length).toBe(1);
    expect(q(q(el, "li")[1]!, "input").length).toBe(1);
  });

  test("ordered task lists render checkboxes too", () => {
    expect(q(render("1. [x] a\n2. [ ] b"), "input").length).toBe(2);
  });
});

describe("AC-17 strikethrough", () => {
  test("renders a del element", () => {
    const el = render("a ~~x~~ b");
    expect(q(el, "del").length).toBe(1);
    expect(q(el, "del")[0]!.textContent).toBe("x");
  });

  test("nests inside emphasis and holds emphasis", () => {
    const el = render("**~~a~~** ~~*b*~~");
    expect(q(q(el, "strong")[0]!, "del").length).toBe(1);
    expect(q(q(el, "del")[1]!, "em").length).toBe(1);
  });

  test("single tilde or unclosed markers render as literal text", () => {
    const el = render("~x~ and ~~y");
    expect(q(el, "del").length).toBe(0);
    expect(el.textContent).toBe("~x~ and ~~y");
  });

  test("del works inside a table cell and a heading", () => {
    expect(q(render("| h |\n| - |\n| ~~x~~ |"), "del").length).toBe(1);
    expect(q(render("# ~~x~~"), "del").length).toBe(1);
  });
});
