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
    const t = make(() => data([f("<b>x</b>\u202e.ts", "M")]));
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

describe("ChangesView.ready", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });
  /** Each fetch waits until the test answers it, like a slow server. */
  function slow() {
    const pending: ((d: ChangesData) => void)[] = [];
    const m = mockFetch(() => new Promise<Response>((r) => pending.push((d) => r(Response.json(d)))));
    restore = m.restore;
    const v = new C.ChangesView({ debounce: 0 });
    const settled = (p: Promise<void>) => {
      let done = false;
      void p.then(() => (done = true));
      return async () => {
        await tick();
        return done;
      };
    };
    return { v, pending, settled };
  }

  test("resolves at once outside a repository and when the list is current", async () => {
    const t = slow();
    expect(await t.settled(t.v.ready())()).toBe(true);
    t.v.setRepo(true);
    t.v.onShown(); // starts a refresh
    t.pending.shift()!(data([f("a.ts", "M")]));
    await tick();
    expect(t.v.files.map((x) => x.path)).toEqual(["a.ts"]);
    expect(await t.settled(t.v.ready())()).toBe(true);
    expect(t.pending.length).toBe(0); // current: nothing fetched again
  });

  test("a stale hidden list is refreshed first", async () => {
    const t = slow();
    t.v.setRepo(true); // hidden: stale, nothing in flight
    const done = t.settled(t.v.ready());
    expect(t.pending.length).toBe(1);
    expect(await done()).toBe(false);
    t.pending.shift()!(data([f("b.ts", "A")]));
    expect(await done()).toBe(true);
    expect(t.v.files.map((x) => x.path)).toEqual(["b.ts"]);
  });

  test("waits for the refresh queued behind the one in flight (the `again` race)", async () => {
    const t = slow();
    t.v.setRepo(true);
    t.v.onShown(); // refresh 1 in flight
    void t.v.refresh(); // queued: `again`
    const done = t.settled(t.v.ready());
    t.pending.shift()!(data([f("old.ts", "M")]));
    await tick();
    expect(await done()).toBe(false); // refresh 1 landed but refresh 2 is now in flight
    expect(t.pending.length).toBe(1);
    t.pending.shift()!(data([f("new.ts", "M")]));
    expect(await done()).toBe(true);
    expect(t.v.files.map((x) => x.path)).toEqual(["new.ts"]);
  });

  test("the repository going away releases waiters", async () => {
    const t = slow();
    t.v.setRepo(true);
    t.v.onShown();
    const done = t.settled(t.v.ready());
    expect(await done()).toBe(false);
    t.v.setRepo(false);
    expect(await done()).toBe(true);
    expect(t.v.files).toEqual([]);
  });
});

describe("risk flags in the Changes view", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  async function load(files: ChangeFile[]) {
    const m = mockFetch(() => Response.json(data(files)));
    restore = m.restore;
    const v = new C.ChangesView({ debounce: 0 });
    const el = v.el as unknown as FakeElement;
    v.setRepo(true);
    await v.refresh();
    return { v, list: el.querySelector(".ch-list")!, summary: el.querySelector(".ch-summary-wrap")! };
  }

  const attrs = (tag: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
    return out;
  };
  /** The rows of the rendered list as HTML strings (rows contain no nested divs). */
  const rowsOf = (html: string) => html.split('<div class="ch-row').slice(1).map((r) => '<div class="ch-row' + r.split("</div>")[0] + "</div>");
  /** Badge elements of a row: attributes, text and the offset in the row. */
  const badges = (row: string) =>
    [...row.matchAll(/<(\w+)([^>]*)>([^<]*)<\/\1>/g)]
      .map((m) => ({ attrs: attrs(m[2]!), text: m[3]!, at: m.index! }))
      .filter((b) => (b.attrs.class ?? "").split(/\s+/).includes("risk"));
  const rowFor = (html: string, path: string) => rowsOf(html).find((r) => attrs(r.match(/^<div[^>]*>/)![0]).title?.startsWith(path + " ·"));

  test("flags(path) reports the computed flags of a listed row", async () => {
    const t = await load([
      f("a.sh", "A", 1, 0, { oldMode: "000000", newMode: "100755" }),
      f("package-lock.json", "M", 2, 1),
      f("plain.txt", "M"),
    ]);
    expect(t.v.flags("a.sh")).toEqual(["exec"]);
    expect(t.v.flags("package-lock.json")).toEqual(["lockfile"]);
    expect(t.v.flags("plain.txt")).toEqual([]);
    expect(t.v.flags("nope")).toEqual([]);
  });

  test("a flagged row has a badge after the path with text, title and aria-label", async () => {
    const t = await load([f("a.sh", "A", 1, 0, { oldMode: "000000", newMode: "100755" })]);
    const row = rowFor(t.list.innerHTML, "a.sh")!;
    expect(row).toBeDefined();
    const all = badges(row);
    expect(all.length).toBe(1);
    const [b, ...rest] = all;
    expect(rest).toEqual([]);
    expect(b!.text).toBe("exec");
    expect(b!.attrs.title).toBe("executable bit added");
    expect(b!.attrs["aria-label"]).toBe("executable bit added");
    expect(b!.at).toBeGreaterThan(row.indexOf('class="ch-name"'));
  });

  test("every flag has its visible text, and multiple flags keep union order", async () => {
    const cases: Array<[ChangeFile, string[], string[]]> = [
      [f("l", "A", 1, 0, { oldMode: "000000", newMode: "120000" }), ["symlink"], ["new symbolic link"]],
      [f(".github/workflows/ci.yml", "M"), ["CI"], ["CI configuration"]],
      [f(".husky/pre-commit", "M"), ["hook"], ["git hook"]],
      [f("yarn.lock", "M"), ["lock"], ["dependency lockfile"]],
      [f("Dockerfile", "M"), ["manifest"], ["package manifest or build file"]],
      [f(".env.local", "M"), ["env"], ["environment or registry configuration"]],
      [f(".github/workflows/deploy.sh", "A", 1, 0, { oldMode: "000000", newMode: "100755" }), ["exec", "CI"], ["executable bit added", "CI configuration"]],
      [f(".husky/.env", "M"), ["hook", "env"], ["git hook", "environment or registry configuration"]],
    ];
    for (const [file, texts, labels] of cases) {
      const t = await load([file]);
      restore?.();
      restore = null;
      const bs = badges(rowFor(t.list.innerHTML, file.path)!);
      expect(bs.map((b) => b.text)).toEqual(texts);
      expect(bs.map((b) => b.attrs.title)).toEqual(labels);
      expect(bs.map((b) => b.attrs["aria-label"])).toEqual(labels);
    }
  });

  test("hostile paths are escaped, badges included", async () => {
    const evil = '.husky/<img src=x onerror=1>"q".sh';
    const t = await load([f(evil, "A", 1, 0, { oldMode: "000000", newMode: "100755" }), f('Dockerfile.<b>"x"', "M")]);
    const html = t.list.innerHTML;
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    const row = rowsOf(html).find((r) => r.includes("&lt;img"))!;
    expect(badges(row).map((b) => b.text)).toEqual(["exec", "hook"]);
    // Attribute values are closed strings (the path's quotes are entities) and no attribute is named onerror.
    for (const r of rowsOf(html)) {
      const tag = r.match(/<div[^>]*>/)![0];
      expect(Object.keys(attrs(tag))).not.toContain("onerror");
      expect(tag.replace(/<div|>$/g, "").replace(/\s[\w-]+="[^"]*"/g, "").trim()).toBe("");
    }
    expect(attrs(rowsOf(html).find((r) => r.includes("&lt;img"))!.match(/<div[^>]*>/)![0]).title).toContain("&quot;q&quot;");
  });

  test("summary appends the flagged count only when rows are flagged", async () => {
    const t = await load([
      f("a.sh", "A", 1, 0, { oldMode: "000000", newMode: "100755" }),
      f("package.json", "M"),
      f("plain.txt", "M"),
    ]);
    expect(t.summary.innerHTML).toContain("· 2 flagged");
    expect(t.summary.innerHTML.match(/flagged/g)!.length).toBe(1);
    // The count is announced by the persistent .ch-riskcount element, not by the wrapper.
    expect(t.summary.getAttribute("role")).toBeNull();
    expect(t.summary.innerHTML.match(/role="status"/g)!.length).toBe(1);
    const none = await load([f("plain.txt", "M"), f("b.ts", "M", 1, 0, { oldMode: "100644", newMode: "100644" })]);
    expect(none.summary.innerHTML).not.toContain("flagged");
    expect(none.summary.getAttribute("role")).toBeNull();
    expect(none.summary.innerHTML.match(/role="status"/g)!.length).toBe(1);
  });

  test("Part B: the live region is the persistent ch-riskcount element, outside ch-counts", async () => {
    const flaggedT = await load([f("a.sh", "A", 1, 0, { oldMode: "000000", newMode: "100755" }), f("package.json", "M"), f("plain.txt", "M")]);
    const none = await load([f("plain.txt", "M")]);
    for (const t of [flaggedT, none]) {
      const html = t.summary.innerHTML;
      expect(t.summary.getAttribute("role")).toBeNull();
      expect(t.summary.getAttribute("aria-live")).toBeNull();
      expect(html).not.toContain("aria-live");
      expect(html.match(/role="status"/g)!.length).toBe(1);
      const tag = html.match(/<[^>]*role="status"[^>]*>/)![0];
      expect(tag).toContain('class="ch-riskcount"');
      // A sibling of .ch-counts inside .ch-summary: not within the .ch-counts element.
      const start = html.indexOf('<span class="ch-counts"');
      expect(start).toBeGreaterThan(-1);
      const riskAt = html.indexOf('class="ch-riskcount"');
      let depth = 0, end = -1;
      for (const m of html.slice(start).matchAll(/<(\/?)span\b/g)) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) { end = start + m.index! + "</span>".length; break; }
      }
      expect(end).toBeGreaterThan(start);
      expect(riskAt).toBeGreaterThanOrEqual(end);
      expect(html.slice(start, end)).not.toContain("ch-riskcount");
    }
    expect(flaggedT.summary.innerHTML).toContain('<span class="ch-riskcount" role="status">· 2 flagged</span>');
    expect(none.summary.innerHTML).toContain('<span class="ch-riskcount" role="status"></span>');
  });

  test("Part B: ch-riskcount stays at the same markup position when the flagged count changes", async () => {
    const a = await load([f("a.sh", "A", 1, 0, { oldMode: "000000", newMode: "100755" })]);
    const b = await load([f("plain.txt", "M")]);
    // Same neighbours in both renders: right after .ch-counts and right before .ch-vs.
    for (const t of [a, b]) {
      expect(t.summary.innerHTML).toMatch(/<\/span><span class="ch-riskcount" role="status">[^<]*<\/span><span class="ch-vs">/);
    }
    expect(a.summary.innerHTML).toContain("· 1 flagged");
    expect(b.summary.innerHTML).not.toContain("flagged");
  });

  test("Part B: styles keep ch-riskcount from shrinking and ch-counts ellipsised; DESIGN.md has the round", () => {
    const css = require("node:fs").readFileSync(`${import.meta.dir}/../src/client/styles.css`, "utf8") as string;
    const rule = (sel: string) => [...css.matchAll(new RegExp(`(?:^|\\n)${sel.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]).join(" ");
    expect(rule(".ch-riskcount")).toMatch(/flex-shrink:\s*0/);
    expect(rule(".ch-riskcount")).not.toContain("ellipsis");
    expect(rule(".ch-counts")).toContain("text-overflow: ellipsis");
    const design = require("node:fs").readFileSync(`${import.meta.dir}/../DESIGN.md`, "utf8") as string;
    expect(design).toContain("## 29. Round 20: hidden characters");
    const sec = design.slice(design.indexOf("## 29. Round 20"));
    expect(sec).toMatch(/hidden characters[^\n]*4 votes|4 votes[^\n]*hidden/i);
    expect(sec).toContain("| Finding | Fix |");
  });

  test("a row with hidden characters has the hidden badge, and the summary counts it once", async () => {
    const t = await load([
      f("notes.md", "M", 1, 0, { hidden: 3 }),
      f("plain.txt", "M"),
      f("run.sh", "A", 1, 0, { oldMode: "000000", newMode: "100755", hidden: 1 }),
    ]);
    const row = rowFor(t.list.innerHTML, "notes.md")!;
    expect(row).toBeDefined();
    expect(row).toContain(
      '<span class="risk risk-hidden" title="hidden or invisible characters" aria-label="hidden or invisible characters">hidden</span>',
    );
    expect(badges(row).map((b) => b.text)).toEqual(["hidden"]);
    expect(badges(row)[0]!.at).toBeGreaterThan(row.indexOf('class="ch-name"'));
    expect(badges(rowFor(t.list.innerHTML, "run.sh")!).map((b) => b.text)).toEqual(["exec", "hidden"]);
    expect(badges(rowFor(t.list.innerHTML, "plain.txt")!)).toEqual([]);
    expect(t.summary.innerHTML).toContain("· 2 flagged");
    const one = await load([f("notes.md", "M", 1, 0, { hidden: 1 }), f("plain.txt", "M")]);
    expect(one.summary.innerHTML).toContain("· 1 flagged");
    expect(t.v.flags("notes.md")).toEqual(["hidden"]);
  });

  test("flags do not reorder rows, and an unflagged row renders as before", async () => {
    const files = [f("z.ts", "M", 10, 2), f("package.json", "M"), f("a.ts", "M", 1, 0, { oldMode: "100644", newMode: "100644" })];
    const t = await load(files);
    expect(t.v.files.map((x) => x.path)).toEqual(["a.ts", "package.json", "z.ts"]);
    const titles = rowsOf(t.list.innerHTML).map((r) => attrs(r.match(/<div[^>]*>/)![0]).title);
    expect(titles).toEqual(["a.ts · Modified", "package.json · Modified", "z.ts · Modified"]);
    expect(rowsOf(t.list.innerHTML)[0]).toBe(
      '<div class="ch-row git-M" data-i="0" id="ch-0" role="option" aria-selected="false" title="a.ts · Modified">' +
        '<span class="gbadge">M</span><span class="ch-name">a.ts</span><span class="ch-dir"></span>' +
        '<span class="ch-add">+1</span><span class="ch-del"></span></div>',
    );
    expect(badges(rowsOf(t.list.innerHTML)[0]!)).toEqual([]);
  });
});
