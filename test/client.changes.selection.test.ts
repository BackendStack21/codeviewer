import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { FakeEvent, installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";
import type { ChangeFile } from "../src/client/api.ts";

let C: typeof import("../src/client/changes.ts");
let restore = () => {};
beforeAll(async () => {
  installDom();
  C = await import("../src/client/changes.ts");
});
afterEach(() => restore());
afterAll(() => uninstallDom());

const f = (path: string, status: ChangeFile["status"] = "M"): ChangeFile => ({ path, status, added: 1, removed: 1, binary: false });

test("the keyboard selection follows its file when a refresh inserts rows above it", async () => {
  let files = [f("a.ts"), f("b.ts"), f("c.ts")];
  const m = mockFetch(async () => Response.json({ repo: true, scope: "head", base: null, rev: "R", files, truncated: false, commits: 0, subjects: [] }));
  restore = m.restore;
  const view = new C.ChangesView({ debounce: 0 });
  view.setRepo(true);
  await view.refresh();
  const list = (view as unknown as { list: FakeElement }).list;
  const key = (k: string) => list.dispatchEvent(new FakeEvent("keydown", { key: k }) as never);
  const sel = () => view.files[(view as unknown as { sel: number }).sel]?.path;
  key("ArrowDown");
  key("ArrowDown");
  expect(sel()).toBe("b.ts");
  files = [f("zz.ts", "D"), ...files]; // the agent deletes a file: it sorts first
  await view.refresh();
  expect(sel()).toBe("b.ts");
  const opened: string[] = [];
  view.onOpen = (x) => void opened.push(x.path);
  key("Enter");
  expect(opened).toEqual(["b.ts"]);
  files = [f("a.ts"), f("c.ts")]; // the selected file left the list: nothing is selected
  await view.refresh();
  expect(sel()).toBeUndefined();
});

test("a reviewed file that is written again is unreviewed, even when its +/- counts stay the same", async () => {
  const files = [f("a.ts"), f("b.ts"), f("c.ts")];
  const m = mockFetch(async () => Response.json({ repo: true, scope: "head", base: null, rev: "R", files, truncated: false, commits: 0, subjects: [] }));
  restore = m.restore;
  const view = new C.ChangesView({ debounce: 0 });
  view.setRepo(true);
  await view.refresh();
  for (const p of ["a.ts", "b.ts", "c.ts"]) view.setCurrent(p);
  expect(view.unreviewedCount()).toBe(0);
  // The agent rewrites the line it had already changed in a.ts: still +1 -1 in the listing.
  view.onFilesChanged(["a.ts", "unrelated.txt"]);
  await view.refresh();
  expect(view.unreviewedCount()).toBe(1);
  const seen = (p: string) => (view as unknown as { isSeen(p: string): boolean }).isSeen(p);
  expect(seen("a.ts")).toBe(false);
  expect(seen("b.ts")).toBe(true);
  // A burst too large to list (`many`) leaves nothing reviewed.
  view.onFilesChanged([], true);
  expect(view.unreviewedCount()).toBe(3);
});
