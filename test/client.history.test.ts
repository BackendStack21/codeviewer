import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom } from "./helpers/fakedom.ts";
import type { HistoryEntry } from "../src/client/api.ts";

// A File History tab shows one commit's change to a file. It is fixed: the Changes view's
// refreshes, file-change reloads and ⌥F5 past the last hunk must leave it alone.

let E: typeof import("../src/client/editor.ts");
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let restore = () => {};

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
});
afterEach(() => restore());
afterAll(() => {
  (Object.getPrototypeOf(document.createElement("div")) as { querySelector: unknown }).querySelector = saved.qs;
  delete saved.qs;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  uninstallDom();
});

const OID = "1".repeat(40);
const PARENT = "2".repeat(40);
const commit: HistoryEntry = { oid: OID, parent: PARENT, author: "Ann", time: Date.now(), subject: "change b", path: "a.ts", status: "M" };

const setup = () => {
  const m = mockFetch((url) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/api/git/base") return new Response(u.searchParams.get("rev") === OID ? "a\nB\nc\n" : "a\nb\nc\n");
    if (u.pathname === "/api/file") return new Response("live\n", { headers: { "x-cv-kind": "text", "x-cv-size": "5", "x-cv-mtime": "1" } });
    return new Response("{}", { status: 404 });
  });
  restore = m.restore;
  const ed = new E.Editor(document.createElement("div") as unknown as HTMLElement);
  return { ed, calls: m.calls };
};

test("a commit diff loads both sides from git by object id, never the working tree", async () => {
  const { ed, calls } = setup();
  await ed.openCommitDiff(commit);
  const urls = calls.map((c) => c.url);
  expect(urls).toContain(`/api/git/base?path=a.ts&rev=${PARENT}`);
  expect(urls).toContain(`/api/git/base?path=a.ts&rev=${OID}`);
  expect(urls.some((u) => u.startsWith("/api/file"))).toBe(false);
  const t = ed.active!;
  expect(t.commit?.oid).toBe(OID);
  expect(t.diff!.stats).toEqual({ added: 1, removed: 1 });
  expect(t.tabEl.innerHTML).toContain('<span class="tab-kind oid">1111111</span>');
  expect(ed.serialize().tabs).toEqual([]); // not restored next session
});

test("an added file in its first commit has an empty old side; a root commit is not asked for a parent", async () => {
  const { ed, calls } = setup();
  await ed.openCommitDiff({ ...commit, parent: null, status: "A" });
  expect(calls.filter((c) => c.url.startsWith("/api/git/base")).map((c) => c.url)).toEqual([`/api/git/base?path=a.ts&rev=${OID}`]);
  expect(ed.active!.diff!.stats).toEqual({ added: 3, removed: 0 });
});

test("Changes refreshes, file changes and the Changes diff of the same file leave the commit tab alone", async () => {
  const { ed, calls } = setup();
  await ed.openCommitDiff(commit, { pin: true });
  const tab = ed.active!;
  const n = calls.length;
  let positions = 0;
  ed.refreshDiffs({ rev: PARENT, vs: "vs main" }, []);
  ed.setDiffPositions(() => (positions++, { i: 1, n: 1 }));
  ed.onChanged(["a.ts"]);
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.length).toBe(n);
  expect(positions).toBe(0);
  expect(tab.diff!.stats).toEqual({ added: 1, removed: 1 });

  // The working-tree diff of a.ts opens as its own tab.
  await ed.openDiff({ path: "a.ts", status: "M", added: 1, removed: 1, binary: false }, { rev: PARENT, vs: "vs main" }, { pin: true });
  expect(ed.tabs.length).toBe(2);
  expect(ed.active).not.toBe(tab);
  expect(ed.active!.commit).toBeUndefined();
});

test("past the last hunk, a commit diff does not step into the Changes list", async () => {
  const { ed } = setup();
  await ed.openCommitDiff(commit);
  const steps: number[] = [];
  ed.onDiffStep = (d) => steps.push(d);
  ed.nextChange(1);
  ed.nextChange(1);
  ed.nextChange(1);
  expect(steps).toEqual([]);
});

test("Go to Symbol and Copy Reference explain themselves in a diff tab", async () => {
  const { ed } = setup();
  expect(ed.outline()).toBe("Open a file to see its symbols");
  expect(ed.referenceTarget()).toBe("Open a file first");
  await ed.openCommitDiff(commit);
  expect(ed.outline()).toBe("Go to Symbol works in files, not diffs");
  expect(ed.referenceTarget()).toBe("Open the file (not its diff) to copy a line reference");
});
