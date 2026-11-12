import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mockFetch, uninstallDom } from "./helpers/fakedom.ts";
import { loadCodeView, type Env } from "./helpers/selfake.ts";
import type { ChangeFile } from "../src/client/api.ts";

let env: Env;
let E: typeof import("../src/client/editor.ts");
const saved: Record<string, unknown> = {};
let restore = () => {};

beforeAll(async () => {
  env = await loadCodeView();
  const proto = Object.getPrototypeOf(env.dom.document.createElement("div")) as Record<string, unknown>;
  saved.qs = proto.querySelector;
  const qs = proto.querySelector as (s: string) => unknown;
  proto.querySelector = function (this: unknown, sel: string) {
    return qs.call(this, sel) ?? (sel === ".tab-close" ? env.dom.document.createElement("button") : null);
  };
  if (!proto.prepend) {
    saved.prepend = true;
    proto.prepend = function (this: { children: unknown[] }, ...n: unknown[]) {
      this.children.unshift(...n);
    };
  }
  E = await import("../src/client/editor.ts");
});
afterEach(() => restore());
afterAll(() => {
  const proto = Object.getPrototypeOf(env.dom.document.createElement("div")) as Record<string, unknown>;
  proto.querySelector = saved.qs;
  if (saved.prepend) delete proto.prepend;
  uninstallDom();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cf = (path: string): ChangeFile => ({ path, status: "M", added: 1, removed: 1, binary: false });

test("openDiff tells its caller whether that diff is the one on screen (a slow load that lost the race is not)", async () => {
  const m = mockFetch(async (url) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/api/git/base") return new Response("old\n");
    if (u.pathname === "/api/file") {
      if (u.searchParams.get("path") === "big.ts") await sleep(60);
      return new Response("new\n", { headers: { "x-cv-kind": "text", "x-cv-size": "4", "x-cv-mtime": "1" } });
    }
    return new Response("{}", { status: 404 });
  });
  restore = m.restore;
  const editor = new E.Editor(env.dom.document.createElement("div") as never);
  const ctx = { rev: "R", vs: "HEAD" } as never;
  const big = editor.openDiff(cf("big.ts"), ctx, { focus: false });
  await sleep(5);
  const small = editor.openDiff(cf("small.ts"), ctx, { focus: false });
  // The caller (app.ts) marks the file current and reviewed in Changes only when this is true.
  expect(await small).toBe(true);
  expect(await big).toBe(false);
  expect(editor.active?.path).toBe("small.ts");
});

test("a heading link scrolls the Markdown preview even when a diff tab of the same file comes first", () => {
  const editor = new E.Editor(env.dom.document.createElement("div") as never);
  const calls: string[] = [];
  (editor as unknown as { tabs: unknown[] }).tabs.push(
    { path: "docs/a.md", isDiff: true, diff: {} },
    { path: "docs/a.md", md: { scrollToFragment: (h: string) => void calls.push(h) } },
  );
  editor.revealFragment("docs/a.md", "install");
  expect(calls).toEqual(["install"]);
});

test("a reload that fails after a newer reload succeeded does not mark the tab deleted", async () => {
  let n = 0;
  const m = mockFetch(async (url) => {
    const u = new URL(url, "http://x");
    if (u.pathname !== "/api/file") return new Response("{}", { status: 404 });
    const k = ++n;
    if (k === 2) {
      await sleep(40); // the file was briefly missing; this answer arrives last
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return new Response("x\n", { headers: { "x-cv-kind": "text", "x-cv-size": "2", "x-cv-mtime": "1" } });
  });
  restore = m.restore;
  const editor = new E.Editor(env.dom.document.createElement("div") as never);
  await editor.open("a.ts", { pin: true, focus: false });
  editor.onChanged(["a.ts"]);
  editor.onChanged(["a.ts"]);
  await sleep(120);
  expect(n).toBe(3);
  expect(editor.tabs[0]!.deleted).toBeFalsy();
});
