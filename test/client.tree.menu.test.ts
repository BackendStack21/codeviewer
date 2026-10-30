import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { FakeEvent, installDom, uninstallDom, type Dom, type FakeElement } from "./helpers/fakedom.ts";

// The explorer's file context menu: "Open in New Tab" always, "View Changes" only inside a git
// repository (every file, not only badged ones: the Changes view may compare with the base branch).
let dom: Dom;
let T: typeof import("../src/client/tree.ts");
let m: typeof import("../src/client/menu.ts");
const g = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  dom = installDom();
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  g.requestAnimationFrame = () => 1;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify([{ name: "src", type: "dir" }, { name: "a.ts", type: "file" }]))) as typeof fetch;
  T = await import("../src/client/tree.ts");
  m = await import("../src/client/menu.ts");
});
afterAll(() => {
  globalThis.fetch = realFetch;
  uninstallDom();
});
beforeEach(() => {
  m.closeContextMenu();
  dom.document.body.replaceChildren();
});

type Tree = InstanceType<typeof T.FileTree> & { flat: { path: string }[] };
const labels = () => dom.document.body.querySelectorAll<FakeElement>(".ctx-item").map((b) => b.textContent);

/** Right-clicks the row of `path`: the fake DOM has no innerHTML children, so the row is a stub under the scroller. */
function openMenu(t: Tree, path: string) {
  const i = t.flat.findIndex((n) => n.path === path);
  expect(i).toBeGreaterThanOrEqual(0);
  const row = dom.document.createElement("div");
  row.setAttribute("class", "row");
  row.setAttribute("data-i", String(i));
  (t.el as unknown as FakeElement).append(row);
  const e = new FakeEvent("contextmenu", { clientX: 10, clientY: 10 });
  row.dispatchEvent(e);
  expect(e.defaultPrevented).toBe(true);
  return row;
}

test("a file offers View Changes only in a git repository, and it reports the file's path", async () => {
  const t = new T.FileTree("root") as Tree;
  await t.init();
  const viewed: string[] = [];
  const opened: [string, boolean][] = [];
  t.onViewChanges = (p) => viewed.push(p);
  t.onOpen = (p, pin) => opened.push([p, pin]);

  openMenu(t, "a.ts");
  expect(labels()).toEqual(["Open in New Tab"]);
  m.closeContextMenu();

  t.git = { repo: true } as unknown as typeof t.git;
  openMenu(t, "a.ts");
  expect(labels()).toEqual(["Open in New Tab", "View Changes"]);
  dom.document.body.querySelectorAll<FakeElement>(".ctx-item")[1]!.dispatchEvent(new FakeEvent("click"));
  expect(viewed).toEqual(["a.ts"]);
  expect(opened).toEqual([]);
  expect(m.isContextMenuOpen()).toBe(false);

  // Folders are unchanged: no diff for a directory.
  openMenu(t, "src");
  expect(labels()).toEqual(["Expand", "Search in Folder…", "Collapse All"]);
});
