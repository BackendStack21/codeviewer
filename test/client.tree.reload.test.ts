import { afterAll, beforeAll, expect, test } from "bun:test";
import { installDom, uninstallDom } from "./helpers/fakedom.ts";

// A watcher event that lands while a folder listing is already in flight must not be lost:
// the stale request's answer predates the change, so the folder is listed once more.
let T: typeof import("../src/client/tree.ts");
const g = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  installDom();
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  g.requestAnimationFrame = () => 1;
  T = await import("../src/client/tree.ts");
});
afterAll(() => {
  globalThis.fetch = realFetch;
  uninstallDom();
});

test("a change during an in-flight listing re-lists the folder", async () => {
  const listings: Record<string, string[][]> = { "": [["dir"]], dir: [["a"], ["a", "b"], ["a", "b", "c"]] };
  const calls: string[] = [];
  let release: (() => void) | null = null;
  globalThis.fetch = (async (url: string) => {
    const p = decodeURIComponent(url.split("path=")[1] ?? "");
    calls.push(p);
    const q = listings[p]!;
    const names = q.length > 1 ? q.shift()! : q[0]!;
    // The second listing of "dir" hangs until released, like a slow server.
    if (p === "dir" && calls.filter((c) => c === "dir").length === 2) await new Promise<void>((r) => (release = r));
    return new Response(JSON.stringify(names.map((n) => ({ name: n, type: n === "dir" ? "dir" : "file" }))));
  }) as typeof fetch;
  const t = new T.FileTree("root") as unknown as {
    init(): Promise<void>;
    toggle(n: unknown, open: boolean): Promise<void>;
    onChanged(paths: string[]): Promise<void> | void;
    byPath: Map<string, unknown>;
  };
  await t.init();
  await t.toggle(t.byPath.get("dir"), true); // [a]
  const p1 = t.onChanged(["dir/b"]); // listing 2, blocked
  await Bun.sleep(5);
  const p2 = t.onChanged(["dir/c"]); // arrives while listing 2 is in flight
  await Bun.sleep(5);
  release!();
  await Promise.all([p1, p2]);
  await Bun.sleep(5);
  expect(calls.filter((c) => c === "dir").length).toBe(3); // expand, the blocked reload, and one more for the change that arrived meanwhile
  expect(t.byPath.has("dir/b")).toBe(true);
  expect(t.byPath.has("dir/c")).toBe(true);
});

test("an unreadable folder shows why instead of looking empty, and the tree names its selected row", async () => {
  globalThis.fetch = (async (url: string) => {
    const p = decodeURIComponent(url.split("path=")[1] ?? "");
    if (p === "") return new Response(JSON.stringify([{ name: "locked", type: "dir" }, { name: "a.txt", type: "file" }]));
    return new Response(JSON.stringify({ error: "EACCES: permission denied" }), { status: 400 });
  }) as typeof fetch;
  const t = new T.FileTree("root") as unknown as {
    el: HTMLElement;
    init(): Promise<void>;
    toggle(n: unknown, open: boolean): Promise<void>;
    byPath: Map<string, unknown>;
    flat: { name: string; note?: string }[];
    focus(): void;
    render(): void;
  };
  await t.init();
  await t.toggle(t.byPath.get("locked"), true);
  const note = t.flat.find((n) => n.note);
  expect(note?.note).toBe("error");
  expect(note?.name).toMatch(/^Can't read folder: /);
  t.focus();
  const el = t.el as unknown as { getAttribute(n: string): string | null; innerHTML: string; clientHeight: number };
  el.clientHeight = 600; // the fake DOM has no layout: give the virtualizer a viewport
  t.render();
  expect(el.getAttribute("role")).toBe("tree");
  expect(el.getAttribute("aria-activedescendant")).toBe("tr-0");
  expect(el.innerHTML).toContain('id="tr-0" data-i="0" aria-level="1" aria-selected="true"');
  expect(el.innerHTML).toContain('class="row file note error"');
});
