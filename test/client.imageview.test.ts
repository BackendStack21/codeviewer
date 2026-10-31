import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

// An image the window cannot decode (damaged, or TIFF/HEIC outside WebKit) must not be a dead
// end: the tab falls back to the hex dump it showed before the format counted as an image.

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
  const proto = Object.getPrototypeOf(document.createElement("div")) as {
    querySelector(s: string): unknown;
    prepend?: (...n: unknown[]) => void;
    insertBefore(n: unknown, ref: unknown): unknown;
    firstChild?: unknown;
  };
  saved.qs = proto.querySelector;
  // The fake DOM has no prepend(): the SVG source toggle is put in front of the view with it.
  if (!proto.prepend) {
    saved.prepend = true;
    proto.prepend = function (this: { children: unknown[] }, ...n: unknown[]) {
      this.children.unshift(...n);
    };
  }
  const qs = proto.querySelector;
  proto.querySelector = function (this: unknown, sel: string) {
    return qs.call(this, sel) ?? (sel === ".tab-close" ? document.createElement("button") : null);
  };
  E = await import("../src/client/editor.ts");
});
afterEach(() => restore());
afterAll(() => {
  (Object.getPrototypeOf(document.createElement("div")) as { querySelector: unknown }).querySelector = saved.qs;
  delete saved.qs;
  if (saved.prepend) delete (Object.getPrototypeOf(document.createElement("div")) as { prepend?: unknown }).prepend;
  delete saved.prepend;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  uninstallDom();
});

const flush = () => new Promise((r) => setTimeout(r, 20));

const setup = (rawOk: boolean) => {
  const m = mockFetch((url) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/api/file") return new Response("", { headers: { "x-cv-kind": "image", "x-cv-size": "6", "x-cv-mtime": "1" } });
    if (u.pathname === "/api/raw" && u.searchParams.get("limit")) return new Response(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00]));
    if (u.pathname === "/api/raw") return rawOk ? new Response(new Uint8Array([1, 2, 3])) : new Response("no", { status: 500 });
    return new Response("{}", { status: 404 });
  });
  restore = m.restore;
  return { ed: new E.Editor(document.createElement("div") as unknown as HTMLElement), calls: m.calls };
};

const find = (el: unknown, cls: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement) => {
    if (n.className?.split?.(" ").includes(cls)) out.push(n);
    for (const c of n.children ?? []) walk(c as FakeElement);
  };
  walk(el as FakeElement);
  return out;
};

test("a file the window cannot decode falls back to a hex dump with a notice", async () => {
  const { ed, calls } = setup(true);
  await ed.open("scan.tiff");
  await flush();
  const tab = ed.tabs[0]!;
  const img = find(tab.el, "img")[0]!;
  expect(img).toBeDefined();
  img.dispatchEvent({ type: "error" } as never);
  await flush();
  expect(find(tab.el, "binary-view").length).toBe(1);
  expect(find(tab.el, "notice")[0]!.textContent).toContain("could not be displayed");
  expect(calls.map((c) => c.url)).toContain("/api/raw?path=scan.tiff&limit=4096");
  // A second error event (e.g. after a reload) does not stack another dump.
  img.dispatchEvent({ type: "error" } as never);
  await flush();
  expect(find(tab.el, "binary-view").length).toBe(1);
});

test("a failed fetch of the image takes the same path", async () => {
  const { ed } = setup(false);
  await ed.open("photo.jpg");
  await flush();
  expect(find(ed.tabs[0]!.el, "binary-view").length).toBe(1);
});

test("the SVG source toggle ignores letter case", async () => {
  const { ed } = setup(true);
  await ed.open("LOGO.SVG");
  await flush();
  expect(find(ed.tabs[0]!.el, "view-toggle").length).toBe(1);
});
