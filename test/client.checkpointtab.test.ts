import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom } from "./helpers/fakedom.ts";
import type { SinceDiff } from "../src/client/checkpointctl.ts";

// The since-checkpoint diff tab: both sides are handed in, it is fixed like a commit tab, and it is
// never tied to the Changes list.

let E: typeof import("../src/client/editor.ts");
let D: typeof import("../src/client/diffview.ts");
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let restore = () => {};

interface Rec {
  texts: { self: unknown; old: string | null; now: string | null }[];
  infos: { self: unknown; info: { path: string; letter: string; label: string; vs: string } }[];
  positions: { self: unknown; pos: unknown }[];
}
const rec: Rec = { texts: [], infos: [], positions: [] };

beforeAll(async () => {
  installDom();
  for (const k of ["requestAnimationFrame", "ResizeObserver", "cancelAnimationFrame"]) saved[k] = g[k];
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => {};
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  // The fake DOM does not build innerHTML children: hand the tab strip a close button to wire up.
  const proto = Object.getPrototypeOf(document.createElement("div")) as { querySelector(s: string): unknown };
  const qs = proto.querySelector;
  saved.qs = qs;
  proto.querySelector = function (this: unknown, sel: string) {
    return qs.call(this, sel) ?? (sel === ".tab-close" ? document.createElement("button") : null);
  };
  E = await import("../src/client/editor.ts");
  D = await import("../src/client/diffview.ts");
  // Record what the diff view is told, and call through.
  const dp = D.DiffView.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ["setTexts", "setInfo", "setPosition"]) {
    const orig = dp[name]!;
    saved[`dv.${name}`] = orig;
    dp[name] = function (this: unknown, ...a: unknown[]) {
      if (name === "setTexts") rec.texts.push({ self: this, old: a[0] as string | null, now: a[1] as string | null });
      else if (name === "setInfo") rec.infos.push({ self: this, info: a[0] as Rec["infos"][number]["info"] });
      else rec.positions.push({ self: this, pos: a[0] });
      return orig.apply(this, a);
    };
  }
});
afterEach(() => {
  restore();
  rec.texts.length = 0;
  rec.infos.length = 0;
  rec.positions.length = 0;
});
afterAll(() => {
  const dp = D.DiffView.prototype as unknown as Record<string, unknown>;
  for (const name of ["setTexts", "setInfo", "setPosition"]) {
    dp[name] = saved[`dv.${name}`];
    delete saved[`dv.${name}`];
  }
  (Object.getPrototypeOf(document.createElement("div")) as { querySelector: unknown }).querySelector = saved.qs;
  delete saved.qs;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  uninstallDom();
});

const setup = () => {
  const m = mockFetch((url) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/api/git/base") return new Response("base\n");
    if (u.pathname === "/api/file") return new Response("live\n", { headers: { "x-cv-kind": "text", "x-cv-size": "5", "x-cv-mtime": "1" } });
    return new Response("{}", { status: 404 });
  });
  restore = m.restore;
  const ed = new E.Editor(document.createElement("div") as unknown as HTMLElement);
  return { ed, calls: m.calls };
};

const d = (over: Partial<SinceDiff> = {}): SinceDiff => ({ path: "src/a.ts", status: "M", oldText: "a\nb\n", newText: "a\nB\nc\n", since: "07:05", ...over });
const lastTexts = (self: unknown) => rec.texts.filter((t) => t.self === self).at(-1);
const lastInfo = (self: unknown) => rec.infos.filter((t) => t.self === self).at(-1)?.info;

test("opens an active diff tab and tells the diff view both sides", async () => {
  const { ed } = setup();
  await ed.openSinceDiff(d());
  const t = ed.active;
  expect(t?.isDiff).toBe(true);
  expect(t?.path).toBe("src/a.ts");
  expect(ed.tabs.length).toBe(1);
  expect(lastTexts(t?.diff)).toMatchObject({ old: "a\nb\n", now: "a\nB\nc\n" });
  expect(t?.diff?.stats).toEqual({ added: 2, removed: 1 });
});

test("a null side is an empty text: added and deleted files diff as all-added and all-removed", async () => {
  const { ed } = setup();
  await ed.openSinceDiff(d({ path: "n.ts", status: "A", oldText: null, newText: "1\n2\n" }), { pin: true });
  expect(lastTexts(ed.active?.diff)).toMatchObject({ old: "", now: "1\n2\n" });
  expect(ed.active?.diff?.stats).toEqual({ added: 2, removed: 0 });
  await ed.openSinceDiff(d({ path: "z.ts", status: "D", oldText: "1\n2\n3\n", newText: null }), { pin: true });
  expect(lastTexts(ed.active?.diff)).toMatchObject({ old: "1\n2\n3\n", now: "" });
  expect(ed.active?.diff?.stats).toEqual({ added: 0, removed: 3 });
});

test("the diff header info carries the status letter, its label and 'since HH:MM'", async () => {
  const { ed } = setup();
  const infos = [] as { letter: string; label: string; vs: string; path: string }[];
  for (const [status, label] of [["A", "Added"], ["M", "Modified"], ["D", "Deleted"]] as const) {
    await ed.openSinceDiff(d({ path: `${status}.ts`, status }), { pin: true });
    infos.push(lastInfo(ed.active?.diff)!);
    expect(infos.at(-1)).toMatchObject({ path: `${status}.ts`, letter: status, label, vs: "since 07:05" });
  }
  expect(infos.length).toBe(3);
});

test("a diff tab is active after the call, focus defaults to true as for a commit tab", async () => {
  const { ed } = setup();
  await ed.openSinceDiff(d({ path: "one.ts" }), { pin: true });
  await ed.openSinceDiff(d({ path: "two.ts" }), { pin: true, focus: false });
  expect(ed.active?.path).toBe("two.ts");
  expect(ed.tabs.map((t) => t.path)).toEqual(["one.ts", "two.ts"]);
});

test("without pin it replaces the unpinned preview tab; with pin it stays", async () => {
  const { ed } = setup();
  await ed.openSinceDiff(d({ path: "one.ts" }));
  await ed.openSinceDiff(d({ path: "two.ts" }));
  expect(ed.tabs.map((t) => t.path)).toEqual(["two.ts"]);
  await ed.openSinceDiff(d({ path: "three.ts" }), { pin: true });
  await ed.openSinceDiff(d({ path: "four.ts" }));
  expect(ed.tabs.map((t) => t.path)).toEqual(["four.ts", "three.ts"]);
});

test("the tab strip shows the file name and 'since HH:MM'; title and breadcrumb carry it too", async () => {
  const { ed } = setup();
  await ed.openSinceDiff(d());
  expect(ed.active?.isDiff).toBe(true);
  const t = ed.active!;
  expect(t.tabEl.innerHTML).toContain("a.ts");
  expect(t.tabEl.innerHTML).toMatch(/<span class="tab-kind[^"]*">since 07:05<\/span>/);
  expect(t.tabEl.title).toContain("src/a.ts");
  expect(t.tabEl.title).toContain("changed since 07:05");
  expect(ed.el.innerHTML).toMatch(/<span class="pill"[^>]*>since 07:05<\/span>/);
});

test("path text in the tab strip, title and breadcrumb is escaped and hidden characters are made visible", async () => {
  const { ed } = setup();
  await ed.openSinceDiff(d({ path: "dir\u202e/<b>x.ts" }));
  expect(ed.active?.isDiff).toBe(true);
  const t = ed.active!;
  expect(t.tabEl.innerHTML).not.toContain("<b>");
  expect(t.tabEl.innerHTML).toContain("&lt;b&gt;");
  expect(t.tabEl.innerHTML).not.toContain("\u202e");
  expect(t.tabEl.title).not.toContain("\u202e");
  expect(t.tabEl.title).toContain("\\u202e");
  expect(ed.el.innerHTML).toContain("dir\\u202e");
  expect(ed.el.innerHTML).toMatch(/<span class="pill"[^>]*>since 07:05<\/span>/);
});

test("it makes no fetch, even when the file is open elsewhere", async () => {
  const { ed, calls } = setup();
  await ed.openSinceDiff(d());
  await ed.openSinceDiff(d({ path: "b.ts", status: "A", oldText: null }), { pin: true });
  expect(ed.tabs.length).toBe(2);
  expect(calls.length).toBe(0);
});

test("reopening the same path and label reuses the tab and refreshes its texts; another label opens another tab", async () => {
  const { ed } = setup();
  await ed.openSinceDiff(d(), { pin: true });
  const first = ed.active;
  await ed.openSinceDiff(d({ path: "other.ts" }), { pin: true });
  expect(ed.active).not.toBe(first);
  await ed.openSinceDiff(d({ newText: "fresh\n" }));
  expect(ed.tabs.length).toBe(2);
  expect(ed.active).toBe(first);
  expect(lastTexts(first?.diff)).toMatchObject({ old: "a\nb\n", now: "fresh\n" });
  await ed.openSinceDiff(d({ since: "08:30" }), { pin: true });
  expect(ed.tabs.length).toBe(3);
  expect(ed.active).not.toBe(first);
  expect(ed.active?.tabEl.innerHTML).toContain("since 08:30");
});

test("the Changes diff of the same file is its own tab and leaves the since tab alone", async () => {
  const { ed } = setup();
  await ed.openSinceDiff(d(), { pin: true });
  const since = ed.active!;
  const before = rec.texts.filter((t) => t.self === since.diff).length;
  await ed.openDiff({ path: "src/a.ts", status: "M", added: 1, removed: 1, binary: false }, { rev: "R2", vs: "vs HEAD" }, { pin: true });
  expect(ed.tabs.length).toBe(2);
  expect(ed.active).not.toBe(since);
  expect(rec.texts.filter((t) => t.self === since.diff).length).toBe(before);
});

test("Changes refreshes, positions, file changes and stepping past the last hunk leave it alone", async () => {
  const { ed, calls } = setup();
  await ed.openSinceDiff(d(), { pin: true });
  expect(ed.active?.isDiff).toBe(true);
  const tab = ed.active!;
  const texts = rec.texts.filter((t) => t.self === tab.diff).length;
  const infos = rec.infos.filter((t) => t.self === tab.diff).length;
  let asked = 0;
  ed.refreshDiffs({ rev: "R9", vs: "vs main" }, [{ path: "src/a.ts", status: "D", added: null, removed: null, binary: false }]);
  ed.setDiffPositions(() => (asked++, { i: 1, n: 3 }));
  ed.onChanged(["src/a.ts"]);
  await new Promise((r) => setTimeout(r, 0));
  expect(asked).toBe(0);
  expect(calls.length).toBe(0);
  expect(rec.texts.filter((t) => t.self === tab.diff).length).toBe(texts);
  expect(rec.infos.filter((t) => t.self === tab.diff).length).toBe(infos);
  expect(lastInfo(tab.diff)).toMatchObject({ letter: "M", label: "Modified", vs: "since 07:05" });
  // It never gets a position: no "n/N" and no next/previous file arrows.
  expect(rec.positions.filter((p) => p.self === tab.diff).every((p) => p.pos === null)).toBe(true);
  const steps: number[] = [];
  ed.onDiffStep = (dir) => steps.push(dir);
  ed.nextChange(1);
  ed.nextChange(1);
  ed.nextChange(1);
  ed.nextChange(-1);
  expect(steps).toEqual([]);
});

test("it closes like any tab and is not part of the saved session", async () => {
  const { ed } = setup();
  await ed.openSinceDiff(d(), { pin: true });
  expect(ed.tabs.length).toBe(1);
  expect(ed.serialize()).toEqual({ tabs: [], active: null });
  ed.close(ed.active);
  expect(ed.tabs.length).toBe(0);
  expect(ed.active).toBeNull();
});
