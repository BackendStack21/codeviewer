import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, mockFetch, uninstallDom, type Dom } from "./helpers/fakedom.ts";

let dom: Dom;
let u: typeof import("../src/client/util.ts");
let umac: typeof import("../src/client/util.ts");

beforeAll(async () => {
  dom = installDom({ platform: "Linux x86_64" });
  u = await import("../src/client/util.ts?linux");
  uninstallDom();
  dom = installDom({ platform: "MacIntel" });
  umac = await import("../src/client/util.ts?mac");
  dom = installDom({ platform: "Linux x86_64" });
});
afterAll(() => uninstallDom());

describe("platform", () => {
  test("MOD / IS_MAC follow navigator.platform at load", () => {
    expect(u.IS_MAC).toBe(false);
    expect(u.MOD).toBe("Ctrl+");
    expect(umac.IS_MAC).toBe(true);
    expect(umac.MOD).toBe("⌘");
  });
});

describe("h", () => {
  test("builds element with class, attributes, boolean attrs and children", () => {
    const child = u.h("i", null, "x");
    const el = u.h("div", { class: "a b", id: "z", hidden: true, off: false, nul: null, undef: undefined, n: 5 }, "t", child, null, false, [u.h("b"), "s"]);
    expect(el.className).toBe("a b");
    expect(el.getAttribute("id")).toBe("z");
    expect(el.getAttribute("hidden")).toBe("");
    expect(el.getAttribute("off")).toBeNull();
    expect(el.getAttribute("nul")).toBeNull();
    expect(el.getAttribute("n")).toBe("5");
    expect(el.innerHTML).toBe('t<i>x</i><b></b>s');
  });
  test("html prop and on* handlers", () => {
    let hit = 0;
    const el = u.h("button", { html: "<svg/>", onclick: () => hit++ });
    expect(el.innerHTML).toBe("<svg/>");
    el.dispatchEvent(new FakeEvent("click") as unknown as Event);
    expect(hit).toBe(1);
  });
});

describe("string helpers", () => {
  test("esc escapes & < > \"", () => {
    expect(u.esc(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    expect(u.esc("plain")).toBe("plain");
  });
  test("basename / dirname", () => {
    expect(u.basename("a/b/c.ts")).toBe("c.ts");
    expect(u.basename("c.ts")).toBe("c.ts");
    expect(u.dirname("a/b/c.ts")).toBe("a/b");
    expect(u.dirname("c.ts")).toBe("");
  });
  test("formatBytes", () => {
    expect(u.formatBytes(0)).toBe("0 B");
    expect(u.formatBytes(1023)).toBe("1023 B");
    expect(u.formatBytes(1024)).toBe("1.0 KB");
    expect(u.formatBytes(1536)).toBe("1.5 KB");
    expect(u.formatBytes(20 * 1024)).toBe("20 KB");
    expect(u.formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(u.formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(u.formatBytes(5000 * 1024 ** 4)).toBe("5000 TB");
  });
});

describe("store", () => {
  let restore = () => {};
  afterEach(() => restore());

  test("init loads settings from the server, get falls back to default, set debounces a PUT", async () => {
    const m = mockFetch((url) => (url === "/api/settings" ? Response.json({ theme: "dark" }) : new Response("{}")));
    restore = m.restore;
    await u.store.init();
    expect(dom.window.listenerCount("pagehide")).toBe(1);
    expect(u.store.get("theme", "light")).toBe("dark");
    expect(u.store.get("missing", 7)).toBe(7);
    u.store.set("a", 1);
    u.store.set("b", 2);
    expect(m.calls.length).toBe(1); // only the GET so far
    await new Promise((r) => setTimeout(r, 400));
    expect(m.calls.length).toBe(2);
    const put = m.calls[1]!;
    expect(put.url).toBe("/api/settings");
    expect(put.init?.method).toBe("PUT");
    expect(JSON.parse(put.init!.body as string)).toEqual({ theme: "dark", a: 1, b: 2 });
    expect(u.store.get("a", 0)).toBe(1);
  });

  test("pagehide saves immediately with keepalive and cancels the pending timer", async () => {
    const m = mockFetch(() => Response.json({}));
    restore = m.restore;
    dom.window.listeners.clear(); // drop pagehide handlers added by earlier init() calls
    await u.store.init();
    u.store.set("k", "v");
    dom.window.dispatchEvent(new FakeEvent("pagehide") as unknown as Event);
    expect(m.calls.length).toBe(2);
    expect(m.calls[1]!.init?.keepalive).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(m.calls.length).toBe(2);
  });

  test("init survives a failing server and a failing save", async () => {
    const m = mockFetch(() => {
      throw new Error("offline");
    });
    restore = m.restore;
    await u.store.init();
    expect(u.store.get("theme", "x")).toBe("x");
    dom.window.dispatchEvent(new FakeEvent("pagehide") as unknown as Event);
    await Promise.resolve();
  });
});

describe("local", () => {
  test("round-trips JSON under the cv: prefix", () => {
    u.local.set("x", { a: [1, 2] });
    expect(dom.localStorage.getItem("cv:x")).toBe('{"a":[1,2]}');
    expect(u.local.get("x", null)).toEqual({ a: [1, 2] });
    expect(u.local.get("nope", "d")).toBe("d");
  });
  test("tolerates corrupt data and storage that throws", () => {
    dom.localStorage.setItem("cv:bad", "{oops");
    expect(u.local.get("bad", 3)).toBe(3);
    dom.localStorage.throws = true;
    expect(u.local.get("x", 9)).toBe(9);
    u.local.set("x", 1); // must not throw
    dom.localStorage.throws = false;
  });
});

describe("debounce", () => {
  test("collapses calls, uses the last arguments", async () => {
    const seen: number[] = [];
    const d = u.debounce((n: number) => seen.push(n), 20);
    d(1);
    d(2);
    d(3);
    expect(seen).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toEqual([3]);
  });
});

describe("dragSplitter", () => {
  const ev = (type: string, o: Record<string, unknown> = {}) => new FakeEvent(type, o) as unknown as Event;
  for (const axis of ["x", "y"] as const) {
    test(`axis ${axis}: reports start and deltas, then cleans up`, () => {
      const handle = u.h("div");
      const moves: [number, number][] = [];
      u.dragSplitter(handle, axis, () => 100, (s, d) => moves.push([s, d]));
      const down = ev("pointerdown", { clientX: 10, clientY: 20, pointerId: 1 });
      handle.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      expect(dom.document.body.classList.contains(`resizing-${axis}`)).toBe(true);
      expect(handle.classList.contains("active")).toBe(true);
      handle.dispatchEvent(ev("pointermove", { clientX: 15, clientY: 50 }));
      expect(moves).toEqual([[100, axis === "x" ? 5 : 30]]);
      handle.dispatchEvent(ev("pointerup"));
      expect(dom.document.body.classList.contains(`resizing-${axis}`)).toBe(false);
      expect(handle.classList.contains("active")).toBe(false);
      handle.dispatchEvent(ev("pointermove", { clientX: 99, clientY: 99 }));
      expect(moves.length).toBe(1);
      expect(handle.listenerCount("pointermove")).toBe(0);
    });
  }
});

describe("dismissable", () => {
  const ev = (type: string, o: Record<string, unknown> = {}) => new FakeEvent(type, o) as unknown as Event;
  test("closes on outside mousedown and Escape, not inside; off() detaches", () => {
    const el = u.h("div", null, u.h("span"));
    const outside = u.h("p");
    let closed = 0;
    const off = u.dismissable(el, () => closed++);
    dom.window.dispatchEvent(ev("mousedown", { target: el.children[0] }));
    expect(closed).toBe(0);
    dom.window.dispatchEvent(ev("mousedown", { target: outside }));
    expect(closed).toBe(1);
    dom.window.dispatchEvent(ev("keydown", { key: "a" }));
    expect(closed).toBe(1);
    dom.window.dispatchEvent(ev("keydown", { key: "Escape" }));
    expect(closed).toBe(2);
    off();
    dom.window.dispatchEvent(ev("keydown", { key: "Escape" }));
    expect(closed).toBe(2);
    expect(dom.window.listenerCount("mousedown")).toBe(0);
  });
  test("keep() exempts targets; custom key handler replaces Escape", () => {
    const el = u.h("div");
    const anchor = u.h("a");
    const keys: string[] = [];
    let closed = 0;
    const off = u.dismissable(el, () => closed++, { keep: (t) => t === anchor, key: (e) => keys.push(e.key) });
    dom.window.dispatchEvent(ev("mousedown", { target: anchor }));
    expect(closed).toBe(0);
    dom.window.dispatchEvent(ev("keydown", { key: "Escape" }));
    expect(closed).toBe(0);
    expect(keys).toEqual(["Escape"]);
    off();
  });
  test("transient also closes on blur/resize/wheel and cleans those up", () => {
    const el = u.h("div");
    let closed = 0;
    const off = u.dismissable(el, () => closed++, { transient: true });
    for (const t of ["blur", "resize", "wheel"]) dom.window.dispatchEvent(ev(t));
    expect(closed).toBe(3);
    off();
    for (const t of ["blur", "resize", "wheel"]) {
      dom.window.dispatchEvent(ev(t));
      expect(dom.window.listenerCount(t)).toBe(0);
    }
    expect(closed).toBe(3);
  });
});
