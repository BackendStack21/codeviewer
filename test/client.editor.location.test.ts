import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mockFetch, uninstallDom } from "./helpers/fakedom.ts";
import { loadCodeView, mount, type Env } from "./helpers/selfake.ts";
import { NavHistory, type NavLoc } from "../src/client/navhistory.ts";
import { Navigation } from "../src/client/navigation.ts";

// Back/Forward fidelity: which line and which view of a file the Editor reports as "where I am".

let env: Env;
let E: typeof import("../src/client/editor.ts");
const g = globalThis as Record<string, unknown>;
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
  void g;
});

const flush = () => new Promise((r) => setTimeout(r, 20));
const L = 20;
const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

/** An Editor whose active tab is a real code view (60 lines, line height L) and nothing else. */
function withCode() {
  const m = mount(env, body);
  (m.view as Record<string, unknown>).lh = L;
  const ed = new E.Editor(env.dom.document.createElement("div") as unknown as HTMLElement);
  const tab = { path: "src/a.ts", kind: "text", code: m.view, pinned: true } as never;
  ed.tabs.push(tab);
  ed.active = tab;
  return { ed, m };
}

const view = (m: ReturnType<typeof mount>, scrollTop: number, clientHeight: number) => {
  const s = m.scroller as unknown as Record<string, number>;
  s.scrollTop = scrollTop;
  s.clientHeight = clientHeight;
};

describe("AC-16 location() line is on screen", () => {
  test("no click: the topmost visible line, 1-based", () => {
    const { ed, m } = withCode();
    view(m, 10 * L, 5 * L);
    expect(m.view.activeLine).toBe(-1);
    expect(ed.location()).toEqual({ path: "src/a.ts", line: 11 });
  });

  test("a click inside the visible range wins", () => {
    const { ed, m } = withCode();
    view(m, 10 * L, 5 * L);
    m.view.activeLine = 12;
    expect(ed.location()?.line).toBe(13);
  });

  test("a click outside the visible range is replaced by the topmost visible line", () => {
    const { ed, m } = withCode();
    view(m, 10 * L, 5 * L);
    m.view.activeLine = 2;
    expect(ed.location()?.line).toBe(11);
    m.view.activeLine = 40;
    expect(ed.location()?.line).toBe(11);
  });

  test("the first and last visible rows are inside the range", () => {
    const { ed, m } = withCode();
    view(m, 10 * L, 5 * L);
    m.view.activeLine = 10;
    expect(ed.location()?.line).toBe(11);
    m.view.activeLine = 14;
    expect(ed.location()?.line).toBe(15);
    m.view.activeLine = 15; // one row below the 5 visible ones
    expect(ed.location()?.line).toBe(11);
  });

  test("scrolled to the top and no click: line 1", () => {
    const { ed, m } = withCode();
    view(m, 0, 5 * L);
    expect(ed.location()?.line).toBe(1);
  });

  test("firstVisibleLine and lastVisibleLine are 0-based and inclusive", () => {
    const { m } = withCode();
    view(m, 10 * L, 5 * L);
    expect(m.view.firstVisibleLine()).toBe(10);
    expect(m.view.lastVisibleLine()).toBe(14);
    view(m, 10 * L + 5, 5 * L); // a partly shown row counts
    expect(m.view.firstVisibleLine()).toBe(10);
    expect(m.view.lastVisibleLine()).toBe(15);
    view(m, 0, 0); // no layout: 800px assumed
    expect(m.view.firstVisibleLine()).toBe(0);
    expect(m.view.lastVisibleLine()).toBe(39);
  });
});

describe("AC-18 / AC-21 location() and the view", () => {
  test("a rendered Markdown preview reports view preview at line 1", () => {
    const ed = new E.Editor(env.dom.document.createElement("div") as unknown as HTMLElement);
    const tab = { path: "docs/a.md", kind: "text", md: {}, pinned: true } as never;
    ed.tabs.push(tab);
    ed.active = tab;
    expect(ed.location()).toEqual({ path: "docs/a.md", line: 1, view: "preview" });
  });

  test("Markdown source and other text tabs carry no view key", () => {
    const { ed } = withCode();
    const loc = ed.location()!;
    expect("view" in loc).toBe(false);
    const m = mount(env, body);
    const tab = { path: "docs/a.md", kind: "text", code: m.view, pinned: true } as never;
    ed.tabs.push(tab);
    ed.active = tab;
    expect("view" in ed.location()!).toBe(false);
  });

  test("diff and image tabs have no location", () => {
    const ed = new E.Editor(env.dom.document.createElement("div") as unknown as HTMLElement);
    const diff = { path: "a.ts", kind: "text", isDiff: true, pinned: true } as never;
    ed.tabs.push(diff);
    ed.active = diff;
    expect(ed.location()).toBeUndefined();
    const img = { path: "a.png", kind: "image", pinned: true } as never;
    ed.tabs.push(img);
    ed.active = img;
    expect(ed.location()).toBeUndefined();
  });

  const open = async (md: boolean) => {
    const m = mockFetch((url) => {
      const u = new URL(url, "http://x");
      if (u.pathname === "/api/file") {
        const t = md ? "# Title\n\nbody\n" : "x\ny\n";
        return new Response(t, { headers: { "x-cv-kind": "text", "x-cv-size": String(t.length), "x-cv-mtime": "1" } });
      }
      return new Response("{}", { status: 404 });
    });
    restore = m.restore;
    return new E.Editor(env.dom.document.createElement("div") as unknown as HTMLElement);
  };

  test("open(md, {view: preview}) shows the preview and the location says so", async () => {
    const ed = await open(true);
    await ed.open("docs/a.md", { pin: true, view: "preview" });
    await flush();
    expect(ed.active?.md).toBeDefined();
    expect(ed.active?.code).toBeUndefined();
    expect(ed.location()).toEqual({ path: "docs/a.md", line: 1, view: "preview" });
  });

  test("landing: a Markdown preview opened without a line is {line 1, view preview}", async () => {
    const ed = await open(true);
    await ed.open("docs/a.md", { pin: true });
    await flush();
    expect(ed.active?.md).toBeDefined();
    expect(ed.landing("docs/a.md")).toEqual({ path: "docs/a.md", line: 1, view: "preview" });
  });

  test("landing: a line, as source, or a non-Markdown file has no view", async () => {
    const ed = await open(true);
    await ed.open("docs/a.md", { pin: true });
    await flush();
    const l = ed.landing("docs/a.md", 5); // a line only means something in the source
    expect(l).toEqual({ path: "docs/a.md", line: 5 });
    expect("view" in l).toBe(false);
    const ed2 = await open(false);
    await ed2.open("src/b.ts", { pin: true });
    await flush();
    const l2 = ed2.landing("src/b.ts");
    expect(l2).toEqual({ path: "src/b.ts", line: 1 });
    expect("view" in l2).toBe(false);
  });
});

describe("AC-19 round trip and AC-20 closing a tab", () => {
  const A = (view?: "preview"): NavLoc => (view ? { path: "a.md", line: 1, view } : { path: "a.md", line: 1 });
  const B: NavLoc = { path: "b.ts", line: 1 };

  test("preview of a.md, jump to b.ts, Back opens a.md as a preview", async () => {
    const opened: NavLoc[] = [];
    let at: NavLoc | undefined = A("preview");
    const nav = new Navigation({
      open: async (loc) => (opened.push({ ...loc }), (at = { ...loc }), true),
      current: () => at,
      announce: () => {},
      notify: () => {},
    });
    nav.record(at, B);
    at = B;
    await nav.go("back");
    expect(opened.at(-1)).toEqual({ path: "a.md", line: 1, view: "preview" });
    await nav.go("forward");
    expect(opened.at(-1)).toEqual(B);
  });

  test("closing a tab keeps its history entries and Back can reopen it", async () => {
    const m = mockFetch((url) => {
      if (new URL(url, "http://x").pathname === "/api/file") return new Response("x\ny\n", { headers: { "x-cv-kind": "text", "x-cv-size": "4", "x-cv-mtime": "1" } });
      return new Response("{}", { status: 404 });
    });
    restore = m.restore;
    const ed = new E.Editor(env.dom.document.createElement("div") as unknown as HTMLElement);
    const hist = new NavHistory();
    const nav = new Navigation(
      {
        // (the fake DOM cannot reveal a line, so the line is left out)
        open: (loc) => ed.open(loc.path, { pin: true, focus: false }),
        current: () => ed.location(),
        announce: () => {},
        notify: () => {},
      },
      hist,
    );
    await ed.open("src/a.ts", { pin: true });
    await ed.open("src/b.ts", { pin: true });
    await flush();
    nav.record({ path: "src/a.ts", line: 1 }, { path: "src/b.ts", line: 1 });
    const before = hist.entries();
    const idx = hist.index();
    expect(before.length).toBe(2);
    ed.close(ed.tabs.find((t) => t.path === "src/a.ts")!);
    expect(ed.tabs.some((t) => t.path === "src/a.ts")).toBe(false);
    expect(hist.entries()).toEqual(before);
    expect(hist.index()).toBe(idx);
    await nav.go("back");
    await flush();
    expect(ed.tabs.some((t) => t.path === "src/a.ts")).toBe(true);
    expect(ed.location()?.path).toBe("src/a.ts");
  });
});
