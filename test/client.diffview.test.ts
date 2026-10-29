import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";
import type { Hunk } from "../src/client/diff.ts";

let D: typeof import("../src/client/diffview.ts");
const frames: (() => void)[] = [];
let disconnected = 0;
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeAll(async () => {
  installDom();
  for (const k of ["requestAnimationFrame", "ResizeObserver", "cancelAnimationFrame"]) saved[k] = g[k];
  g.requestAnimationFrame = (fn: () => void) => frames.push(fn);
  g.ResizeObserver = class {
    observe() {}
    disconnect() {
      disconnected++;
    }
  };
  g.cancelAnimationFrame = () => {};
  D = await import("../src/client/diffview.ts");
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  uninstallDom();
});
const flush = () => {
  while (frames.length) frames.shift()!();
};

describe("buildRows", () => {
  const hk = (a0: number, a1: number, b0: number, b1: number): Hunk => ({ a0, a1, b0, b1 });

  test("no hunks: no rows", () => {
    expect(D.buildRows([], 10, 10, new Set())).toEqual([]);
  });

  test("context around a change, gaps before and after, expandable by index", () => {
    const rows = D.buildRows([hk(10, 11, 10, 12)], 20, 21, new Set());
    expect(rows).toEqual([
      { k: "gap", a: 0, b: 0, n: 7, g: 0 },
      { k: "ctx", a: 7, b: 7 },
      { k: "ctx", a: 8, b: 8 },
      { k: "ctx", a: 9, b: 9 },
      { k: "del", a: 10, hk: 0 },
      { k: "add", b: 10, hk: 0 },
      { k: "add", b: 11, hk: 0 },
      { k: "ctx", a: 11, b: 12 },
      { k: "ctx", a: 12, b: 13 },
      { k: "ctx", a: 13, b: 14 },
      { k: "gap", a: 14, b: 15, n: 6, g: 1 },
    ]);
    const open = D.buildRows([hk(10, 11, 10, 12)], 20, 21, new Set([1]));
    expect(open.length).toBe(rows.length - 1 + 6);
    expect(open.at(-1)).toEqual({ k: "ctx", a: 19, b: 20 });
    expect(open[0]).toEqual({ k: "gap", a: 0, b: 0, n: 7, g: 0 });
  });

  test("a single hidden line is shown rather than collapsed; two or more collapse", () => {
    // 4 lines before the change: 3 shown as context, 1 would be hidden -> shown.
    expect(D.buildRows([hk(4, 5, 4, 5)], 5, 5, new Set()).slice(0, 4)).toEqual([
      { k: "ctx", a: 0, b: 0 }, { k: "ctx", a: 1, b: 1 }, { k: "ctx", a: 2, b: 2 }, { k: "ctx", a: 3, b: 3 },
    ]);
    expect(D.buildRows([hk(5, 6, 5, 6)], 6, 6, new Set())[0]).toEqual({ k: "gap", a: 0, b: 0, n: 2, g: 0 });
  });

  test("two changes close together share their context; far apart they get a gap between", () => {
    const close = D.buildRows([hk(2, 3, 2, 3), hk(5, 6, 5, 6)], 8, 8, new Set());
    expect(close.filter((r) => r.k === "gap")).toEqual([]);
    expect(close.map((r) => r.k)).toEqual(["ctx", "ctx", "del", "add", "ctx", "ctx", "del", "add", "ctx", "ctx"]);
    const far = D.buildRows([hk(2, 3, 2, 3), hk(50, 51, 50, 51)], 60, 60, new Set());
    const gaps = far.filter((r) => r.k === "gap");
    expect(gaps).toEqual([
      { k: "gap", a: 6, b: 6, n: 41, g: 0 },
      { k: "gap", a: 54, b: 54, n: 6, g: 1 },
    ]);
  });

  test("pure insertions and deletions, and whole-file changes", () => {
    expect(D.buildRows([hk(0, 0, 0, 2)], 0, 2, new Set())).toEqual([{ k: "add", b: 0, hk: 0 }, { k: "add", b: 1, hk: 0 }]);
    expect(D.buildRows([hk(0, 2, 0, 0)], 2, 0, new Set())).toEqual([{ k: "del", a: 0, hk: 0 }, { k: "del", a: 1, hk: 0 }]);
    const ins = D.buildRows([hk(3, 3, 3, 4)], 6, 7, new Set());
    expect(ins.map((r) => r.k)).toEqual(["ctx", "ctx", "ctx", "add", "ctx", "ctx", "ctx"]);
    expect(ins[4]).toEqual({ k: "ctx", a: 3, b: 4 });
  });
});

describe("spansHtml", () => {
  test("wraps tokens, escapes HTML and shows hidden characters", () => {
    expect(D.spansHtml("let x = <a>", [[0, 3, "k"], [8, 11, "o"]])).toBe('<span class="t-k">let</span> x = <span class="t-o">&lt;a&gt;</span>');
    expect(D.spansHtml("", [])).toBe("");
    expect(D.spansHtml("a‮b", [])).toBe("a\\u202eb");
    expect(D.spansHtml("x".repeat(5000), [[0, 5000, "s"]]).length).toBeLessThan(4100);
  });
});

describe("DiffView", () => {
  const info = { path: "src/a.ts", letter: "M" as const, label: "Modified", vs: "vs main" };
  const make = (lang = "js") => {
    const v = new D.DiffView(info, lang, 13);
    const el = v.el as unknown as FakeElement;
    return { v, el, rows: el.querySelector(".diff-rows")!, notice: el.querySelector(".diff-notice")!, head: el.querySelector(".diff-head")! };
  };

  test("header: badge, path, counts, base label, position", () => {
    const t = make();
    expect(t.head.querySelector(".gbadge")!.className).toBe("gbadge git-M");
    expect(t.head.querySelector(".gbadge")!.textContent).toBe("M");
    expect(t.head.querySelector(".diff-path")!.innerHTML).toBe('<span class="diff-dir">src/</span>a.ts');
    expect(t.head.querySelector(".diff-vs")!.textContent).toBe("vs main");
    t.v.setInfo({ path: "b/new.ts", oldPath: "a/old.ts", letter: "R", label: "Renamed", vs: "vs HEAD" });
    expect(t.head.querySelector(".diff-path")!.innerHTML).toBe('<span class="diff-dir">a/</span>old.ts<span class="ch-arrow">→</span><span class="diff-dir">b/</span>new.ts');
    expect(t.head.querySelector(".gbadge")!.className).toBe("gbadge git-R");
    expect(t.head.querySelector(".diff-vs")!.textContent).toBe("vs HEAD");
    t.v.setPosition({ i: 3, n: 7 });
    expect(t.head.querySelector(".diff-n")!.textContent).toBe("3/7");
    expect(t.head.querySelector(".diff-pos")!.hidden).toBe(false);
    t.v.setPosition(null);
    expect(t.head.querySelector(".diff-pos")!.hidden).toBe(true);
  });

  test("rows: numbers on both sides, markers, highlighted text, stats, counts", () => {
    const t = make();
    t.v.setTexts("const a = 1;\nlet b = 2;\nlet c = 3;\n", "const a = 1;\nlet b = 20;\nlet c = 3;\n");
    expect(t.v.stats).toEqual({ added: 1, removed: 1 });
    expect(t.v.hunkCount).toBe(1);
    expect(t.head.querySelector(".diff-counts")!.innerHTML).toBe('<span class="git-A">+1</span><span class="git-D">−1</span>');
    flush();
    const html = t.rows.innerHTML;
    expect(html).toContain('<div class="dr dr-ctx"><span class="dn">1</span><span class="dn">1</span><span class="dm"> </span>');
    expect(html).toContain('<div class="dr dr-del"><span class="dn">2</span><span class="dn"></span><span class="dm">−</span><span class="dt"><span class="t-k">let</span> b = <span class="t-n">2</span>;</span></div>');
    expect(html).toContain('<div class="dr dr-add"><span class="dn"></span><span class="dn">2</span><span class="dm">+</span><span class="dt"><span class="t-k">let</span> b = <span class="t-n">20</span>;</span></div>');
    expect(html).toContain('<span class="dn">3</span><span class="dn">3</span>');
    expect(t.notice.hidden).toBe(true);
  });

  test("new file, deleted file, identical, binary and unavailable old side", () => {
    const t = make("text");
    t.v.setTexts("", "x\ny\n");
    expect(t.v.stats).toEqual({ added: 2, removed: 0 });
    flush();
    expect(t.rows.innerHTML.match(/dr-add/g)!.length).toBe(2);
    t.v.setTexts("x\ny\n", "");
    expect(t.v.stats).toEqual({ added: 0, removed: 2 });
    t.v.setTexts("same\n", "same\n");
    expect(t.notice.hidden).toBe(false);
    expect(t.notice.textContent).toBe("No differences.");
    t.v.setTexts("a\r\nb\n", "a\nb");
    expect(t.notice.textContent).toBe("Only line endings or the final newline changed.");
    expect(t.v.stats).toEqual({ added: 0, removed: 0 });
    expect(t.v.stats).toEqual({ added: 0, removed: 0 });
    t.v.setTexts(null, null, "Binary file changed.");
    expect(t.notice.textContent).toBe("Binary file changed.");
    t.v.setTexts(null, "a\n");
    expect(t.notice.textContent).toBe("The previous version can't be shown (binary or too large).");
    t.v.setTexts("a\n", null);
    expect(t.notice.textContent).toBe("The current version can't be shown (binary or too large).");
  });

  test("gaps collapse and expand on click; nextChange walks hunks and refuses to wrap", () => {
    const t = make("text");
    const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n") + "\n";
    const oldT = lines(40, (i) => `line ${i}`);
    const newT = lines(40, (i) => (i === 5 || i === 30 ? `LINE ${i}` : `line ${i}`));
    t.v.setTexts(oldT, newT);
    expect(t.v.hunkCount).toBe(2);
    flush();
    let html = t.rows.innerHTML;
    expect(html).toContain('data-g="0"');
    expect(html).toContain("2 unchanged lines"); // lines 0-1 (3 lines of context before the change at 5)
    expect(html).toContain("18 unchanged lines"); // between the two changes
    expect(html).toContain("6 unchanged lines"); // after the last change
    expect(html).not.toContain('<span class="dn">1</span><span class="dn">1</span>');
    // Clicking a gap row expands it.
    const gap = { closest: () => ({ dataset: { g: "1" } }) };
    t.rows.dispatchEvent(new FakeEvent("click", { target: gap }));
    flush();
    html = t.rows.innerHTML;
    expect(html).not.toContain("18 unchanged lines");
    expect(html).toContain("2 unchanged lines");
    expect(html).toContain("6 unchanged lines");
    expect(html).toContain('<span class="dn">20</span><span class="dn">20</span>');

    expect(t.v.nextChange(-1)).toBe(true); // from nothing: the last hunk
    flush();
    expect(t.rows.innerHTML).toContain('class="dr dr-del cur flash"><span class="dn">31</span>');
    expect(t.v.nextChange(1)).toBe(false); // nothing after the last hunk: the caller moves on
    expect(t.v.nextChange(-1)).toBe(true);
    flush();
    expect(t.rows.innerHTML).toContain('class="dr dr-del cur flash"><span class="dn">6</span>');
    expect(t.v.nextChange(-1)).toBe(false);
    t.v.setTexts("a\n", "a\n");
    expect(t.v.nextChange(1)).toBe(false);
  });

  test("dispose disconnects the observer", () => {
    const t = make();
    const before = disconnected;
    t.v.dispose();
    expect(disconnected).toBe(before + 1);
  });

  test("font size sets the row height variable", () => {
    const t = make();
    t.v.setFontSize(20);
    expect(t.el.style["--lh"]).toBe("32px");
    expect(t.el.style["--code-size"]).toBe("20px");
  });
});
