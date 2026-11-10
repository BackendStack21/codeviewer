import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";
import type { ChangeFile, ChangesData } from "../src/client/api.ts";

let C: typeof import("../src/client/changes.ts");
beforeAll(async () => {
  installDom();
  C = await import("../src/client/changes.ts");
});
afterAll(() => uninstallDom());

const f = (path: string, status: ChangeFile["status"] = "M", added: number | null = 1, removed: number | null = 0): ChangeFile => ({
  path, status, added, removed, binary: false,
});
const data = (files: ChangeFile[]): ChangesData => ({
  repo: true, scope: "branch", base: { name: "main", oid: "b".repeat(40), mergeBase: "c".repeat(40), same: false }, rev: "c".repeat(40),
  files, truncated: false, commits: 2, subjects: ["feat: one"],
});

const paths = ["a", "b", "c", "d"];
const rev = (...r: string[]) => (p: string) => r.includes(p);

describe("nextUnreviewed", () => {
  test("worked examples (b and d reviewed)", () => {
    const r = rev("b", "d");
    expect(C.nextUnreviewed(paths, "a", 1, r)).toBe(2);
    expect(C.nextUnreviewed(paths, "c", 1, r)).toBe(0);
    expect(C.nextUnreviewed(paths, "a", -1, r)).toBe(2);
    expect(C.nextUnreviewed(paths, null, -1, r)).toBe(2);
    expect(C.nextUnreviewed(paths, "zzz", 1, r)).toBe(0);
    expect(C.nextUnreviewed(paths, null, 1, r)).toBe(0);
    expect(C.nextUnreviewed(paths, "c", -1, r)).toBe(0);
  });

  test("everything reviewed gives -1", () => {
    const r = rev("a", "b", "c", "d");
    for (const dir of [1, -1] as const) for (const cur of ["a", null, "zzz"]) expect(C.nextUnreviewed(paths, cur, dir, r)).toBe(-1);
    expect(C.nextUnreviewed([], null, 1, r)).toBe(-1);
    expect(C.nextUnreviewed([], "a", -1, r)).toBe(-1);
  });

  test("the current file is checked last", () => {
    const r = rev("b", "c", "d");
    expect(C.nextUnreviewed(paths, "a", 1, r)).toBe(0);
    expect(C.nextUnreviewed(paths, "a", -1, r)).toBe(0);
    expect(C.nextUnreviewed(["a"], "a", 1, () => false)).toBe(0);
    expect(C.nextUnreviewed(["a"], "a", -1, () => false)).toBe(0);
    expect(C.nextUnreviewed(["a"], "a", 1, () => true)).toBe(-1);
    expect(C.nextUnreviewed(["a"], null, -1, () => false)).toBe(0);
  });

  test("the predicate only sees members of paths", () => {
    const seen: string[] = [];
    C.nextUnreviewed(paths, "zzz", 1, (p) => (seen.push(p), true));
    C.nextUnreviewed(paths, "b", -1, (p) => (seen.push(p), true));
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) expect(paths).toContain(p);
  });
});

describe("ChangesView unreviewed", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  async function make(files: ChangeFile[]) {
    const m = mockFetch(() => Response.json(data(files)));
    restore = m.restore;
    const v = new C.ChangesView({ debounce: 0 });
    v.setRepo(true);
    await v.refresh();
    const list = (v.el as unknown as FakeElement).querySelector(".ch-list")!;
    return { v, list, files };
  }
  const three = () => [f("c.ts"), f("a.ts"), f("b.ts")];

  test("unreviewedCount follows setCurrent and later edits", async () => {
    const fs = three();
    const t = await make(fs);
    expect(t.v.unreviewedCount()).toBe(3);
    t.v.setCurrent("b.ts");
    expect(t.v.unreviewedCount()).toBe(2);
    fs[2] = f("b.ts", "M", 9, 0);
    await t.v.refresh();
    expect(t.v.unreviewedCount()).toBe(3);
  });

  test("unreviewedCount is 0 for an empty list", async () => {
    const t = await make([]);
    expect(t.v.unreviewedCount()).toBe(0);
  });

  test("stepUnreviewed walks the unreviewed files once, then returns null", async () => {
    const t = await make(three());
    const opened: [string, boolean][] = [];
    t.v.onOpen = (x, pin) => {
      opened.push([x.path, pin]);
      t.v.setCurrent(x.path);
    };
    expect(t.v.stepUnreviewed(1)?.path).toBe("a.ts");
    expect(opened).toEqual([["a.ts", false]]);
    expect(t.v.stepUnreviewed(1)?.path).toBe("b.ts");
    expect(t.v.stepUnreviewed(1)?.path).toBe("c.ts");
    expect(t.v.stepUnreviewed(1)).toBeNull();
    expect(opened.length).toBe(3);
  });

  test("a fresh view steps backwards from the last file", async () => {
    const t = await make(three());
    t.v.onOpen = () => {};
    expect(t.v.stepUnreviewed(-1)?.path).toBe("c.ts");
  });

  test("the search starts at the open file and skips reviewed ones", async () => {
    const t = await make(three());
    t.v.onOpen = () => {};
    t.v.setCurrent("b.ts");
    expect(t.v.stepUnreviewed(1)?.path).toBe("c.ts");
    expect(t.v.stepUnreviewed(-1)?.path).toBe("a.ts");
    restore?.();
    const u = await make(three());
    u.v.onOpen = () => {};
    u.v.setCurrent("a.ts");
    u.v.setCurrent("c.ts");
    expect(u.v.stepUnreviewed(1)?.path).toBe("b.ts");
  });

  test("the chosen row becomes the list selection", async () => {
    const t = await make(three());
    t.v.onOpen = () => {};
    t.v.stepUnreviewed(1);
    expect(t.list.innerHTML).toContain('aria-selected="true"');
    expect(t.list.innerHTML).toMatch(/data-i="0" id="ch-0" role="option" aria-selected="true"/);
    t.v.stepUnreviewed(-1);
    expect(t.list.innerHTML).toMatch(/data-i="2" id="ch-2" role="option" aria-selected="true"/);
  });

  test("an empty list returns null and opens nothing", async () => {
    const t = await make([]);
    let n = 0;
    t.v.onOpen = () => n++;
    expect(t.v.stepUnreviewed(1)).toBeNull();
    expect(t.v.stepUnreviewed(-1)).toBeNull();
    expect(n).toBe(0);
  });

  test("a file changed since review is returned again", async () => {
    const fs = three();
    const t = await make(fs);
    t.v.onOpen = () => {};
    t.v.setCurrent("a.ts");
    t.v.setCurrent("b.ts");
    t.v.setCurrent("c.ts");
    expect(t.v.stepUnreviewed(1)).toBeNull();
    fs[1] = f("a.ts", "M", 7, 2);
    await t.v.refresh();
    expect(t.v.stepUnreviewed(1)?.path).toBe("a.ts");
  });
});

describe("reviewed rows are read as reviewed", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });
  const SR = '<span class="sr-only">, reviewed</span>';

  test("sr-only text follows the path, only on reviewed rows", async () => {
    const m = mockFetch(() => Response.json(data([f("a.ts"), f("src/b.ts"), f("z.ts")])));
    restore = m.restore;
    const v = new C.ChangesView({ debounce: 0 });
    v.setRepo(true);
    await v.refresh();
    const list = (v.el as unknown as FakeElement).querySelector(".ch-list")!;
    expect(list.innerHTML).not.toContain("sr-only");
    v.setCurrent("a.ts");
    expect(list.innerHTML).toContain(`<span class="ch-name">a.ts</span><span class="ch-dir"></span>${SR}`);
    expect(list.innerHTML).toContain('class="ch-row git-M cur seen" data-i="0"');
    expect(list.innerHTML).toContain(" · reviewed (dims until the file changes again)");
    expect(list.innerHTML.split("sr-only").length - 1).toBe(1);
    v.setCurrent("src/b.ts");
    expect(list.innerHTML).toContain(`<span class="ch-name">b.ts</span><span class="ch-dir">src</span>${SR}`);
    expect(list.innerHTML.split("sr-only").length - 1).toBe(2);
  });

  test("an unreviewed row keeps its exact markup", async () => {
    const m = mockFetch(() => Response.json(data([f("a.ts")])));
    restore = m.restore;
    const v = new C.ChangesView({ debounce: 0 });
    v.setRepo(true);
    await v.refresh();
    const list = (v.el as unknown as FakeElement).querySelector(".ch-list")!;
    expect(list.innerHTML).toBe(
      '<div class="ch-row git-M" data-i="0" id="ch-0" role="option" aria-selected="false" title="a.ts · Modified"><span class="gbadge">M</span><span class="ch-name">a.ts</span><span class="ch-dir"></span><span class="ch-add">+1</span><span class="ch-del"></span></div>',
    );
  });
});
