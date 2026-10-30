import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, mockFetch, uninstallDom, type Dom, type FakeElement } from "./helpers/fakedom.ts";

let dom: Dom;
let P: typeof import("../src/client/palette.ts");
beforeAll(async () => {
  dom = installDom();
  P = await import("../src/client/palette.ts");
});
afterAll(() => uninstallDom());

describe("fuzzy", () => {
  test("non-subsequence is null; empty query matches", () => {
    expect(P.fuzzy("xyz", "abc")).toBeNull();
    expect(P.fuzzy("ba", "ab")).toBeNull();
    expect(P.fuzzy("", "abc")!.pos).toEqual([]);
  });
  test("positions are of the matched characters", () => {
    expect(P.fuzzy("ac", "abc")!.pos).toEqual([0, 2]);
  });
  test("prefers word-boundary hits over mid-word hits", () => {
    const a = P.fuzzy("fb", "foo-bar")!;
    const b = P.fuzzy("fb", "fabulous")!;
    expect(a.pos).toEqual([0, 4]);
    expect(a.score).toBeGreaterThan(b.score);
  });
  test("contiguous runs beat scattered; camelCase humps count as boundaries", () => {
    expect(P.fuzzy("abc", "abcxx")!.score).toBeGreaterThan(P.fuzzy("abc", "axbxc")!.score);
    expect(P.fuzzy("gs", "getState")!.pos).toEqual([0, 3]);
  });
  test("case-exact match gets a small bonus", () => {
    expect(P.fuzzy("A", "A")!.score).toBeGreaterThan(P.fuzzy("a", "A")!.score);
  });
  test("spaces in the query are skipped; longer strings are penalised slightly", () => {
    expect(P.fuzzy("a b", "a-b")!.pos).toEqual([0, 2]);
    expect(P.fuzzy("a", "a")!.score).toBeGreaterThan(P.fuzzy("a", "a" + "z".repeat(50))!.score);
  });
});

describe("scorePath / searchPaths", () => {
  test("basename matches outrank directory matches; exact-length basename gets a bonus", () => {
    const base = P.scorePath("app", "src/app.ts")!;
    const dir = P.scorePath("app", "app/src/x.ts")!;
    expect(base.score).toBeGreaterThan(dir.score);
    expect(P.scorePath("app", "src/app")!.score).toBeGreaterThan(P.scorePath("app", "src/apple")!.score);
    expect(P.scorePath("zzz", "src/app.ts")).toBeNull();
  });

  const files = ["src/app.ts", "src/client/palette.ts", "src/server/apps.ts", "README.md", "test/palette.test.ts"];
  const lower = files.map((f) => f.toLowerCase());
  test("returns ranked matches and all hit indices", () => {
    const r = P.searchPaths("pal", files, lower, null);
    expect(r.best.map((b) => b.p)).toEqual(["test/palette.test.ts", "src/client/palette.ts"]); // equal basename scores, shorter path wins
    expect([...r.hits]).toEqual([1, 4]);
  });
  test("a previous hit set narrows the scan", () => {
    const r1 = P.searchPaths("a", files, lower, null);
    const r2 = P.searchPaths("ap", files, lower, r1.hits);
    expect(r2.best.map((b) => b.p).sort()).toEqual(["src/app.ts", "src/server/apps.ts"]);
    // narrowing with a hit set that excludes a file means it is not considered
    const r3 = P.searchPaths("ap", files, lower, Int32Array.from([0]));
    expect(r3.best.map((b) => b.p)).toEqual(["src/app.ts"]);
  });
  test("caps results at 80 and keeps the best", () => {
    const many = Array.from({ length: 200 }, (_, i) => `d/file${i}.ts`).concat(["zzz.ts"]);
    const r = P.searchPaths("zzz", many, many.map((f) => f.toLowerCase()), null);
    expect(r.best.length).toBe(1);
    const r2 = P.searchPaths("file", many, many.map((f) => f.toLowerCase()), null);
    expect(r2.best.length).toBe(80);
    expect(r2.hits.length).toBe(200);
  });
});

describe("Palette", () => {
  let restore = () => {};
  afterEach(() => restore());

  const make = async (index: string[] = ["src/a.ts", "src/b.ts", "docs/readme.md"]) => {
    const m = mockFetch(() => new Response(index.join("\n")));
    restore = m.restore;
    const p = new P.Palette();
    const input = p.el.querySelector<FakeElement>(".palette-input")!;
    const list = p.el.querySelector<FakeElement>(".palette-list")!;
    const type = (v: string) => {
      input.value = v;
      input.dispatchEvent(new FakeEvent("input"));
    };
    const key = (k: string, o: Record<string, unknown> = {}) => {
      const e = new FakeEvent("keydown", { key: k, ...o });
      input.dispatchEvent(e);
      return e;
    };
    const rows = () => [...list.innerHTML.matchAll(/<div class="pal-item( sel)?" data-i="(\d+)"/g)].map((r) => ({ sel: !!r[1], i: +r[2]! }));
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { p, input, list, type, key, rows, flush, calls: m.calls };
  };

  test("combobox semantics: expanded while open, the current option named for assistive tech", async () => {
    const t = await make();
    expect(t.input.getAttribute("role")).toBe("combobox");
    expect(t.input.getAttribute("aria-expanded")).toBe("false");
    t.p.open();
    await t.flush();
    expect(t.input.getAttribute("aria-expanded")).toBe("true");
    expect(t.input.getAttribute("aria-activedescendant")).toBe("pal-0");
    expect(t.list.innerHTML).toContain('data-i="0" id="pal-0" aria-selected="true"');
    t.key("ArrowDown");
    expect(t.input.getAttribute("aria-activedescendant")).toBe("pal-1");
    // (The fake DOM does not materialise innerHTML children, so only the input's attribute is observable here.)
    t.type("zzzz-no-such-file");
    expect(t.input.getAttribute("aria-activedescendant")).toBeNull();
    t.p.close();
    expect(t.input.getAttribute("aria-expanded")).toBe("false");
  });

  test("starts hidden; open shows, focuses and loads the index once", async () => {
    const t = await make();
    expect(t.p.isOpen).toBe(false);
    t.p.open();
    expect(t.p.isOpen).toBe(true);
    expect(t.input.focused).toBe(true);
    // open() renders before the fetch starts, so only typing while loading shows the message
    t.type("a");
    expect(t.list.innerHTML).toContain("Indexing files");
    t.type("");
    await t.flush();
    expect(t.rows().length).toBe(3);
    expect(t.list.innerHTML).toContain("a.ts");
    t.p.close();
    t.p.open();
    await t.flush();
    expect(t.calls.length).toBe(1);
    t.p.invalidate();
    t.p.open();
    await t.flush();
    expect(t.calls.length).toBe(2);
  });

  test("recent files come first and unknown ones are dropped", async () => {
    const t = await make();
    t.p.recent = ["docs/readme.md", "gone.ts"];
    t.p.open();
    await t.flush();
    const html = t.list.innerHTML;
    expect(html.indexOf("readme.md")).toBeLessThan(html.indexOf("a.ts"));
    expect(html).not.toContain("gone.ts");
  });

  test("typing filters, highlights matches, and Enter opens the selection", async () => {
    const t = await make();
    t.p.open();
    await t.flush();
    const opened: [string, number | undefined][] = [];
    t.p.onOpenFile = (p, l) => opened.push([p, l]);
    t.type("rdm");
    expect(t.rows().length).toBe(1);
    expect(t.list.innerHTML).toContain("<b>r</b>");
    t.key("Enter");
    expect(opened).toEqual([["docs/readme.md", undefined]]);
    expect(t.p.isOpen).toBe(false);
  });

  test("path:line opens at the line; no match shows a message", async () => {
    const t = await make();
    t.p.open();
    await t.flush();
    const opened: [string, number | undefined][] = [];
    t.p.onOpenFile = (p, l) => opened.push([p, l]);
    t.type("b.ts:42");
    t.key("Enter");
    expect(opened).toEqual([["src/b.ts", 42]]);
    t.p.open();
    t.type("qqqq");
    expect(t.list.innerHTML).toContain("No matching files");
  });

  test("incremental typing reuses narrowed hits and still gives correct results", async () => {
    const t = await make(["src/alpha.ts", "src/beta.ts", "src/alphabet.ts"]);
    t.p.open();
    await t.flush();
    t.type("al");
    expect(t.rows().length).toBe(2);
    t.type("alpha");
    expect(t.rows().length).toBe(2);
    t.type("alphab");
    expect(t.rows().length).toBe(1);
    t.type("a"); // shorter: not a prefix extension of the last query
    expect(t.rows().length).toBe(3);
  });

  test("arrow keys and ctrl+n/p move the selection with wraparound; handled keys are prevented", async () => {
    const t = await make(["a.ts", "b.ts", "c.ts"]);
    t.p.open();
    await t.flush();
    const opened: string[] = [];
    t.p.onOpenFile = (p) => opened.push(p);
    const pick = () => {
      t.key("Enter");
      t.p.open();
      return opened.at(-1);
    };
    expect(t.key("ArrowUp").defaultPrevented).toBe(true); // wraps to the last
    expect(pick()).toBe("c.ts");
    await t.flush();
    t.key("n", { ctrlKey: true });
    t.key("n", { ctrlKey: true });
    t.key("ArrowDown"); // 0 -> 1 -> 2 -> 0
    expect(pick()).toBe("a.ts");
    await t.flush();
    t.key("p", { ctrlKey: true });
    expect(pick()).toBe("c.ts");
  });

  test("selection index maps to the item run on Enter", async () => {
    const t = await make(["a.ts", "b.ts", "c.ts"]);
    t.p.open();
    await t.flush();
    const got: string[] = [];
    t.p.onOpenFile = (p) => got.push(p);
    t.key("ArrowDown");
    t.key("Enter");
    expect(got).toEqual(["b.ts"]);
  });

  test("Escape closes; unknown keys are not prevented; backdrop mousedown closes", async () => {
    const t = await make();
    t.p.open();
    expect(t.key("x").defaultPrevented).toBe(false);
    t.key("Escape");
    expect(t.p.isOpen).toBe(false);
    t.p.open();
    t.p.el.dispatchEvent(new FakeEvent("mousedown"));
    expect(t.p.isOpen).toBe(false);
    t.p.open();
    t.p.el.children[0]!.dispatchEvent(new FakeEvent("mousedown")); // inside the box: target is not el
    expect(t.p.isOpen).toBe(true);
  });

  test("close restores focus to the previously focused element", async () => {
    const t = await make();
    const btn = dom.document.createElement("button");
    dom.document.body.append(btn);
    btn.focus();
    t.p.open();
    expect(btn.focused).toBe(false);
    t.p.close();
    expect(dom.document.activeElement).toBe(btn);
  });

  test("clicking a row (mousedown) accepts it", async () => {
    const t = await make(["a.ts", "b.ts"]);
    t.p.open();
    await t.flush();
    const got: string[] = [];
    t.p.onOpenFile = (p) => got.push(p);
    const row = dom.document.createElement("div");
    row.className = "pal-item";
    row.setAttribute("data-i", "1");
    t.list.append(row);
    const e = new FakeEvent("mousedown", { target: row });
    t.list.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(got).toEqual(["b.ts"]);
    // a mousedown that is not on a row does nothing
    const e2 = new FakeEvent("mousedown", { target: t.list });
    t.list.dispatchEvent(e2);
    expect(e2.defaultPrevented).toBe(false);
  });

  test("'>' lists commands, filters by fuzzy label, and runs the selected one", async () => {
    const t = await make();
    const ran: string[] = [];
    t.p.commands = [
      { id: "a", label: "Toggle Sidebar", keys: "⌘B", run: () => ran.push("a") },
      { id: "b", label: "Open Terminal", run: () => ran.push("b") },
      { id: "c", label: "Search <files>", run: () => ran.push("c") },
    ];
    t.p.open(">");
    expect(t.rows().length).toBe(3);
    expect(t.list.innerHTML).toContain("<kbd>⌘B</kbd>");
    expect(t.list.innerHTML).toContain("Search &lt;files&gt;");
    t.type(">term");
    expect(t.rows().length).toBe(1);
    t.key("Enter");
    expect(ran).toEqual(["b"]);
    t.p.open(">tgs");
    expect(t.list.innerHTML).toContain("<b>T</b>o<b>g</b>gle <b>S</b>idebar");
  });

  test("':' go-to-line", async () => {
    const t = await make();
    const lines: number[] = [];
    t.p.onGoToLine = (n) => lines.push(n);
    t.p.open(":");
    expect(t.list.innerHTML).toContain("Type a line number");
    t.key("Enter");
    expect(lines).toEqual([]);
    t.p.open(":120");
    expect(t.list.innerHTML).toContain("Go to line <b>120</b>");
    t.key("Enter");
    expect(lines).toEqual([120]);
  });

  test("empty index shows 'No files'", async () => {
    const t = await make([]);
    t.p.open();
    await t.flush();
    expect(t.list.innerHTML).toContain("No files");
  });
});
