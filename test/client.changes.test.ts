import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";
import type { ChangeFile, ChangesData } from "../src/client/api.ts";

let C: typeof import("../src/client/changes.ts");
beforeAll(async () => {
  installDom();
  C = await import("../src/client/changes.ts");
});
afterAll(() => uninstallDom());

const f = (path: string, status: ChangeFile["status"], added: number | null = 1, removed: number | null = 0, extra: Partial<ChangeFile> = {}): ChangeFile => ({
  path, status, added, removed, binary: false, ...extra,
});
const data = (files: ChangeFile[], o: Partial<ChangesData> = {}): ChangesData => ({
  repo: true, scope: "branch", base: { name: "main", oid: "b".repeat(40), mergeBase: "c".repeat(40), same: false }, rev: "c".repeat(40),
  files, truncated: false, commits: 2, subjects: ["feat: one", "fix: two"], ...o,
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("pure helpers", () => {
  test("letterOf maps git's letters to the Explorer vocabulary", () => {
    expect(C.letterOf("?")).toBe("U");
    expect(C.letterOf("U")).toBe("C");
    expect(C.letterOf("X")).toBe("C");
    expect(C.letterOf("C")).toBe("R");
    expect(C.letterOf("T")).toBe("M");
    for (const s of ["M", "A", "D", "R"] as const) expect(C.letterOf(s)).toBe(s);
  });
  test("labelOf", () => {
    expect(C.labelOf(f("a", "T"))).toBe("Type changed");
    expect(C.labelOf(f("a", "C"))).toBe("Copied");
    expect(C.labelOf(f("a", "?"))).toBe("Untracked");
    expect(C.labelOf(f("a", "U"))).toBe("Conflict");
  });
  test("sortChanges: conflicts, deletions, new files, renames, edits; then by path", () => {
    const out = C.sortChanges([f("z.ts", "M"), f("b.ts", "?"), f("a.ts", "M"), f("d.ts", "D"), f("r.ts", "R"), f("c.ts", "U"), f("n.ts", "A")]);
    expect(out.map((x) => x.path)).toEqual(["c.ts", "d.ts", "b.ts", "n.ts", "r.ts", "a.ts", "z.ts"]);
  });
  test("summarize ignores uncounted files", () => {
    expect(C.summarize([f("a", "M", 3, 1), f("b", "?", null, null), f("c", "D", 0, 7)])).toEqual({ added: 3, removed: 8 });
  });
});

describe("ChangesView", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  function make(handler: (url: string) => ChangesData | number) {
    const m = mockFetch((url) => {
      const r = handler(url);
      return typeof r === "number" ? new Response("{}", { status: r }) : Response.json(r);
    });
    restore = m.restore;
    const v = new C.ChangesView({ debounce: 0 });
    const el = v.el as unknown as FakeElement;
    const q = (sel: string) => el.querySelector(sel)!;
    return { v, el, calls: m.calls, list: q(".ch-list"), summary: q(".ch-summary-wrap"), scope: q(".ch-scope") };
  }

  test("not a repository / loading / error states", async () => {
    const t = make(() => 500);
    expect(t.list.innerHTML).toContain("Not a git repository.");
    expect(t.summary.hidden).toBe(true);
    t.v.setRepo(true);
    expect(t.calls.length).toBe(0); // hidden: nothing fetched yet
    t.v.onShown();
    expect(t.calls.length).toBe(1);
    expect(t.list.innerHTML).toContain("Reading changes…");
    await tick();
    await tick();
    expect(t.list.innerHTML).toContain("Could not read the changes.");
    t.v.setRepo(false);
    expect(t.list.innerHTML).toContain("Not a git repository.");
  });

  test("summary, scope control, sorted rows, renames, deletions, binaries, truncation", async () => {
    const files = [
      f("src/z.ts", "M", 10, 2),
      f("src/a.ts", "D", 0, 5),
      f("docs/new.md", "?", 3, 0),
      f("img.png", "?", null, null, { binary: true }),
      f("lib/renamed.ts", "R", 1, 0, { oldPath: "lib/old.ts" }),
      f("moved/same.ts", "R", 0, 0, { oldPath: "lib/same.ts" }),
      f("x.lock", "M", null, null),
    ];
    const t = make(() => data(files, { truncated: true }));
    t.v.setRepo(true);
    await t.v.refresh();
    expect(t.calls[0]!.url).toBe("/api/git/changes?scope=branch");
    const s = t.summary.innerHTML;
    expect(s).toContain("<b>7</b> files");
    expect(s).toContain('<span class="git-A">+14</span>');
    expect(s).toContain('<span class="git-D">−7</span>');
    expect(s).toContain("2 commits");
    expect(s).toContain('title="feat: one\nfix: two"');
    expect(s).toContain('<span class="ch-vs">vs main</span>');
    expect(s).toContain("--p:67%");
    expect(t.scope.hidden).toBe(false);
    expect(t.scope.innerHTML).toContain('data-scope="head" aria-pressed="false">Uncommitted<');
    expect(t.scope.innerHTML).toContain('data-scope="branch" aria-pressed="true">vs main<');
    const rows = [...t.list.innerHTML.matchAll(/<div class="ch-row([^"]*)" data-i="(\d+)"[^>]*title="([^"]*)"/g)].map((m) => [m[2], m[3], m[1]!.trim()]);
    expect(rows.map((r) => r[1])).toEqual([
      "src/a.ts · Deleted",
      "docs/new.md · Untracked",
      "img.png · Untracked",
      "lib/renamed.ts · Renamed",
      "moved/same.ts · Renamed",
      "src/z.ts · Modified",
      "x.lock · Modified",
    ]);
    expect(rows[0]![2]).toBe("git-D deleted");
    const html = t.list.innerHTML;
    expect(html).toContain('<span class="ch-name">old.ts<span class="ch-arrow">→</span>renamed.ts</span><span class="ch-dir">lib</span>');
    expect(html).toContain('<span class="ch-name">same.ts</span><span class="ch-dir">lib<span class="ch-arrow">→</span>moved</span>');
    expect(html).toContain('<span class="ch-bin">bin</span>');
    expect(html).toContain('<span class="ch-bin">—</span>');
    expect(html).toContain('<span class="ch-add">+10</span><span class="ch-del">−2</span>');
    expect(html).toContain('<span class="ch-add"></span><span class="ch-del">−5</span>');
    expect(html).toContain("Showing the first 7 files");
    expect(t.v.files.map((x) => x.path)[0]).toBe("src/a.ts");
  });

  test("paths are escaped and control characters made visible", async () => {
    const t = make(() => data([f("<b>x</b>‮.ts", "M")]));
    t.v.setRepo(true);
    await t.v.refresh();
    expect(t.list.innerHTML).not.toContain("<b>x</b>");
    expect(t.list.innerHTML).toContain("&lt;b&gt;x&lt;/b&gt;\\u202e.ts");
  });

  test("empty states depend on the scope and the base", async () => {
    let d = data([]);
    const t = make(() => d);
    t.v.setRepo(true);
    await t.v.refresh();
    expect(t.list.innerHTML).toContain("No changes vs main.");
    d = data([], { commits: 0, subjects: [] });
    await t.v.refresh();
    expect(t.list.innerHTML).toContain("Branch is up to date with main.");
    d = data([], { scope: "head", base: { name: "main", oid: "b".repeat(40), mergeBase: "b".repeat(40), same: true }, commits: 0 });
    await t.v.refresh();
    expect(t.list.innerHTML).toContain("No uncommitted changes.");
    expect(t.scope.hidden).toBe(true); // nothing on top of the base: no switch
    expect(t.summary.innerHTML).toContain("vs HEAD");
    expect(t.summary.innerHTML).toContain('class="ch-bar empty"');
    d = data([], { scope: "head", base: null, rev: null, commits: 0 });
    await t.v.refresh();
    expect(t.list.innerHTML).toContain("No uncommitted changes.");
  });

  test("keyboard: arrows select, Enter opens (Shift pins), Home/End; step wraps; position and seen", async () => {
    const files = [f("b.ts", "M", 2, 1), f("a.ts", "M", 1, 1), f("c.ts", "D", 0, 3)];
    const t = make(() => data(files));
    const opened: [string, boolean][] = [];
    t.v.onOpen = (x, pin) => opened.push([x.path, pin]);
    t.v.setRepo(true);
    await t.v.refresh();
    const key = (k: string, init: Record<string, unknown> = {}) => t.list.dispatchEvent(new FakeEvent("keydown", { key: k, ...init }));
    key("Enter");
    expect(opened).toEqual([]); // nothing selected yet
    key("ArrowDown");
    expect(t.list.innerHTML).toContain('class="ch-row git-D sel deleted" data-i="0"');
    key("Enter");
    expect(opened).toEqual([["c.ts", false]]);
    key("ArrowDown");
    key("Enter", { shiftKey: true });
    expect(opened[1]).toEqual(["a.ts", true]);
    key("End");
    key("Enter");
    expect(opened[2]).toEqual(["b.ts", false]);
    key("ArrowDown"); // clamped at the end
    key("Enter");
    expect(opened[3]).toEqual(["b.ts", false]);
    key("Home");
    key("Enter");
    expect(opened[4]).toEqual(["c.ts", false]);

    t.v.setCurrent("a.ts");
    expect(t.v.position()).toEqual({ i: 2, n: 3 });
    expect(t.v.position("c.ts")).toEqual({ i: 1, n: 3 });
    expect(t.v.position("nope")).toBeNull();
    expect(t.list.innerHTML).toContain('class="ch-row git-M cur seen" data-i="1"');
    expect(t.v.step(1)?.path).toBe("b.ts");
    expect(opened[5]).toEqual(["b.ts", false]);
    t.v.setCurrent("b.ts");
    expect(t.v.step(1)?.path).toBe("c.ts"); // wraps
    t.v.setCurrent("c.ts");
    expect(t.v.step(-1)?.path).toBe("b.ts");

    // A reviewed file that changes again is no longer dimmed.
    files[1] = f("a.ts", "M", 5, 1);
    await t.v.refresh();
    expect(t.list.innerHTML).toContain('class="ch-row git-M" data-i="1"');
    expect(t.list.innerHTML).toContain('class="ch-row git-M sel seen" data-i="2"');
  });

  test("scope switch and toggleScope refetch; onGitChanged refreshes only when shown or watched", async () => {
    let d = data([f("a.ts", "M")]);
    const t = make((url) => (url.includes("scope=head") ? { ...d, scope: "head" as const, commits: 0 } : d));
    const got: (ChangesData | null)[] = [];
    t.v.onData = (x) => got.push(x);
    t.v.setRepo(true);
    await t.v.refresh();
    expect(got.length).toBe(1);
    t.v.toggleScope();
    await tick();
    await tick();
    expect(t.calls.at(-1)!.url).toBe("/api/git/changes?scope=head");
    expect(t.v.scopeName).toBe("head");
    expect(t.v.vs).toBe("vs HEAD");
    expect(t.summary.innerHTML).toContain("vs HEAD");
    expect(t.scope.innerHTML).toContain('data-scope="head" aria-pressed="true"');
    t.v.setScope("head"); // no-op
    const n = t.calls.length;
    t.v.onGitChanged(); // hidden, no diff tabs: deferred
    await tick();
    expect(t.calls.length).toBe(n);
    t.v.watching = true;
    t.v.onGitChanged();
    await tick();
    await tick();
    expect(t.calls.length).toBe(n + 1);
    t.v.watching = false;
    t.v.onHidden();
    t.v.onGitChanged();
    await tick();
    expect(t.calls.length).toBe(n + 1);
    t.v.onShown(); // stale: refreshes on show
    await tick();
    await tick();
    expect(t.calls.length).toBe(n + 2);
    t.v.onShown(); // fresh: nothing
    expect(t.calls.length).toBe(n + 2);
    // A base-less reply collapses to the single scope and hides the control.
    d = data([f("a.ts", "M")], { base: null, scope: "head", commits: 0 });
    await t.v.refresh();
    expect(t.scope.hidden).toBe(true);
    t.v.toggleScope(); // nothing to toggle to
    expect(t.calls.at(-1)!.url).toBe("/api/git/changes?scope=head");
    expect(got.at(-1)).toMatchObject({ base: null });
    t.v.setRepo(false);
    expect(got.at(-1)).toBeNull();
  });

  test("one request in flight at a time; a refresh asked meanwhile runs once afterwards", async () => {
    let release: (() => void) | null = null;
    const m = mockFetch(() => new Promise<Response>((r) => (release = () => r(Response.json(data([f("a.ts", "M")]))))));
    restore = m.restore;
    const v = new C.ChangesView({ debounce: 0 });
    v.setRepo(true);
    const first = v.refresh();
    expect(m.calls.length).toBe(1);
    void v.refresh();
    void v.refresh();
    v.onGitChanged();
    await tick();
    expect(m.calls.length).toBe(1); // queued, not fired
    release!();
    await first;
    await tick();
    expect(m.calls.length).toBe(2); // exactly one follow-up
    release!();
    await tick();
    await tick();
    expect(m.calls.length).toBe(2);
    expect(v.files.length).toBe(1);
  });

  test("a server reply without a repo clears the list", async () => {
    const t = make(() => ({ repo: false }) as unknown as ChangesData);
    t.v.setRepo(true);
    await t.v.refresh();
    expect(t.v.data).toBeNull();
    expect(t.v.files).toEqual([]);
  });
});
