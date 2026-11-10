import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mockFetch, uninstallDom } from "./helpers/fakedom.ts";
import { loadCodeView, type Env } from "./helpers/selfake.ts";

// Back to a Markdown file that is already open as source must reopen the preview, and a line keeps the source.

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

const flush = () => new Promise((r) => setTimeout(r, 20));

async function setup() {
  const m = mockFetch((url) => {
    if (new URL(url, "http://x").pathname === "/api/file") {
      const t = "# Title\n\nbody\n";
      return new Response(t, { headers: { "x-cv-kind": "text", "x-cv-size": String(t.length), "x-cv-mtime": "1" } });
    }
    return new Response("{}", { status: 404 });
  });
  restore = m.restore;
  const ed = new E.Editor(env.dom.document.createElement("div") as unknown as HTMLElement);
  await ed.open("docs/a.md", { pin: true });
  await flush();
  expect(ed.active?.md).toBeDefined();
  // switch the open tab to its source
  (ed as unknown as { flip(t: unknown): void }).flip(ed.active);
  await flush();
  expect(ed.active?.md).toBeUndefined();
  expect(ed.active?.code).toBeDefined();
  return ed;
}

test("open with view preview on a Markdown tab shown as source shows the preview", async () => {
  const ed = await setup();
  await ed.open("docs/a.md", { pin: true, view: "preview" });
  await flush();
  expect(ed.tabs.length).toBe(1);
  expect(ed.active?.md).toBeDefined();
  expect(ed.active?.code).toBeUndefined();
  expect(ed.location()).toEqual({ path: "docs/a.md", line: 1, view: "preview" });
});

test("open with a line keeps the source, even with view preview", async () => {
  const ed = await setup();
  ed.active!.code!.revealLine = () => {}; // the fake DOM cannot find a row to reveal
  await ed.open("docs/a.md", { pin: true, line: 2, view: "preview" });
  await flush();
  expect(ed.active?.md).toBeUndefined();
  expect(ed.active?.code).toBeDefined();
  expect("view" in ed.location()!).toBe(false);
});
