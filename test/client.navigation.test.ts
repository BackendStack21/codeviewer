import { describe, expect, test } from "bun:test";
import { Navigation, routeNavZoomKey, type NavDeps } from "../src/client/navigation.ts";
import type { NavLoc } from "../src/client/navhistory.ts";

function harness(opts: { missing?: string[] } = {}) {
  const log = { opened: [] as NavLoc[], said: [] as string[], toasts: [] as string[] };
  const state: { at: NavLoc | undefined } = { at: undefined };
  const missing = new Set(opts.missing ?? []);
  let nav!: Navigation;
  const deps: NavDeps = {
    open: async (loc) => {
      if (missing.has(loc.path)) return false;
      log.opened.push({ ...loc });
      state.at = { ...loc };
      // the app's openFile records a jump; during Back/Forward that must be ignored
      nav.record(undefined, { ...loc });
      return true;
    },
    current: () => (state.at ? { ...state.at } : undefined),
    announce: (m) => log.said.push(m),
    notify: (m) => log.toasts.push(m),
  };
  nav = new Navigation(deps);
  return { nav, log, state };
}

const A = (line: number): NavLoc => ({ path: "src/a.ts", line });
const B = (line: number): NavLoc => ({ path: "src/b.ts", line });

describe("AC-14 two jumps, Back, Forward", () => {
  test("Back reopens the first location at its line, Forward the second", async () => {
    const { nav, log, state } = harness();
    state.at = A(1);
    nav.record(A(1), A(42));
    state.at = A(42);
    nav.record(A(42), B(7));
    state.at = B(7);

    await nav.go("back");
    expect(log.opened.at(-1)).toEqual(A(42));
    await nav.go("back");
    expect(log.opened.at(-1)).toEqual(A(1));
    await nav.go("forward");
    expect(log.opened.at(-1)).toEqual(A(42));
    await nav.go("forward");
    expect(log.opened.at(-1)).toEqual(B(7));
  });
  test("Back then Forward returns to where the user actually was", async () => {
    const { nav, log, state } = harness();
    nav.record(undefined, A(5));
    state.at = A(5);
    nav.record(A(5), B(9));
    state.at = B(30); // scrolled within b.ts
    await nav.go("back");
    await nav.go("forward");
    expect(log.opened.at(-1)).toEqual(B(30));
  });
});

describe("AC-15 empty history", () => {
  test("Go Back toasts 'No previous location' and opens nothing", async () => {
    const { nav, log } = harness();
    await nav.go("back");
    expect(log.toasts).toEqual(["No previous location"]);
    expect(log.opened).toEqual([]);
    expect(log.said).toEqual([]);
  });
  test("Go Forward toasts 'No next location'", async () => {
    const { nav, log } = harness();
    await nav.go("forward");
    expect(log.toasts).toEqual(["No next location"]);
  });
  test("at the end of the list Forward toasts, at the start Back toasts", async () => {
    const { nav, log, state } = harness();
    nav.record(A(1), B(2));
    state.at = B(2);
    await nav.go("forward");
    expect(log.toasts).toEqual(["No next location"]);
    await nav.go("back");
    await nav.go("back");
    expect(log.toasts).toEqual(["No next location", "No previous location"]);
  });
});

describe("AC-16 recording", () => {
  test("record() adds to the history", () => {
    const { nav } = harness();
    nav.record(A(1), B(20));
    expect(nav.history.entries()).toEqual([A(1), B(20)]);
  });
  test("opening a file while another is active records from the active location, to line 1", () => {
    const { nav } = harness();
    nav.record(A(33), B(1));
    expect(nav.history.entries()).toEqual([A(33), B(1)]);
  });
  test("Back and Forward do not record (the reopen inside go() is ignored)", async () => {
    const { nav, state } = harness();
    nav.record(A(1), B(50));
    state.at = B(50);
    await nav.go("back");
    expect(nav.history.entries()).toEqual([A(1), B(50)]);
    expect(nav.history.index()).toBe(0);
    await nav.go("forward");
    expect(nav.history.entries()).toEqual([A(1), B(50)]);
    expect(nav.history.index()).toBe(1);
  });
  test("recording works again after a Back finished, even when open() failed", async () => {
    const { nav, state } = harness({ missing: ["src/a.ts"] });
    nav.record(A(1), B(50));
    state.at = B(50);
    await nav.go("back");
    nav.record(B(50), { path: "src/c.ts", line: 3 });
    expect(nav.history.entries().at(-1)).toEqual({ path: "src/c.ts", line: 3 });
  });
});

describe("AC-17 files that no longer open", () => {
  test("a missing file is dropped and Back continues to the next entry", async () => {
    const { nav, log, state } = harness({ missing: ["src/b.ts"] });
    nav.record(A(1), B(2));
    state.at = B(2);
    nav.record(B(2), { path: "src/c.ts", line: 9 });
    state.at = { path: "src/c.ts", line: 9 };
    // history: a:1, b:2, c:9 (current)
    await nav.go("back");
    expect(log.opened).toEqual([A(1)]);
    expect(nav.history.entries().some((e) => e.path === "src/b.ts")).toBe(false);
    expect(log.said).toEqual(["Back to src/a.ts line 1"]);
    expect(log.toasts).toEqual([]);
  });
  test("when every earlier entry is gone, it toasts 'No previous location'", async () => {
    const { nav, log, state } = harness({ missing: ["src/a.ts"] });
    nav.record(A(1), B(2));
    state.at = B(2);
    await nav.go("back");
    expect(log.toasts).toEqual(["No previous location"]);
    expect(log.opened).toEqual([]);
  });
  test("Forward skips a missing file too", async () => {
    const { nav, log, state } = harness({ missing: ["src/b.ts"] });
    nav.record(A(1), B(2));
    nav.record(B(2), { path: "src/c.ts", line: 4 });
    state.at = { path: "src/c.ts", line: 4 };
    await nav.go("back"); // b missing, lands on a
    state.at = A(1);
    await nav.go("forward");
    expect(log.opened.at(-1)).toEqual({ path: "src/c.ts", line: 4 });
  });
  test("drop() removes a deleted file's entries", () => {
    const { nav } = harness();
    nav.record(A(1), B(2));
    nav.drop("src/b.ts");
    expect(nav.history.entries()).toEqual([A(1)]);
  });
});

describe("AC-18 announce", () => {
  test("success announces 'Back to <path> line N' and does not toast", async () => {
    const { nav, log, state } = harness();
    nav.record(A(42), B(7));
    state.at = B(7);
    await nav.go("back");
    expect(log.said).toEqual(["Back to src/a.ts line 42"]);
    expect(log.toasts).toEqual([]);
  });
  test("Forward announces 'Forward to <path> line N'", async () => {
    const { nav, log, state } = harness();
    nav.record(A(42), B(7));
    state.at = B(7);
    await nav.go("back");
    state.at = A(42);
    await nav.go("forward");
    expect(log.said.at(-1)).toBe("Forward to src/b.ts line 7");
    expect(log.toasts).toEqual([]);
  });
});

describe("AC-12 keydown routing on Linux", () => {
  function route(e: Parameters<typeof routeNavZoomKey>[0], o: { isMac: boolean; inTerm: boolean }) {
    const { nav, state } = harness();
    nav.record(A(1), B(2));
    state.at = B(2);
    const zooms: number[] = [];
    const nav2: string[] = [];
    const handled = routeNavZoomKey(e, o, {
      navigate: (d) => {
        nav2.push(d);
        void nav.go(d);
      },
      zoom: (d) => zooms.push(d),
    });
    return { handled, zooms, nav2, nav };
  }
  const lin = { isMac: false, inTerm: false };

  test("Ctrl+Alt+- runs Go Back (history navigates) and does not zoom out", async () => {
    const r = route({ key: "-", code: "Minus", ctrlKey: true, altKey: true }, lin);
    expect(r.handled).toBe(true);
    expect(r.nav2).toEqual(["back"]);
    expect(r.zooms).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.nav.history.index()).toBe(0);
  });
  test("Ctrl+Shift+- runs Go Forward and does not zoom", () => {
    const r = route({ key: "_", ctrlKey: true, shiftKey: true }, lin);
    expect(r.handled).toBe(true);
    expect(r.nav2).toEqual(["forward"]);
    expect(r.zooms).toEqual([]);
  });
  test("plain Ctrl+- still zooms out and does not navigate", () => {
    const r = route({ key: "-", ctrlKey: true }, lin);
    expect(r.handled).toBe(true);
    expect(r.zooms).toEqual([-1]);
    expect(r.nav2).toEqual([]);
  });
  test("macOS: Cmd+- zooms out, Ctrl+- goes back", () => {
    const mac = { isMac: true, inTerm: false };
    const z = route({ key: "-", metaKey: true }, mac);
    expect(z.zooms).toEqual([-1]);
    expect(z.nav2).toEqual([]);
    const b = route({ key: "-", ctrlKey: true }, mac);
    expect(b.nav2).toEqual(["back"]);
    expect(b.zooms).toEqual([]);
  });
  test("Ctrl+= and Ctrl+0 zoom in and reset on Linux", () => {
    expect(route({ key: "=", ctrlKey: true }, lin).zooms).toEqual([1]);
    expect(route({ key: "0", ctrlKey: true }, lin).zooms).toEqual([0]);
  });
  test("in a Linux terminal nothing is handled (keys stay with the shell)", () => {
    const r = route({ key: "-", ctrlKey: true, altKey: true }, { isMac: false, inTerm: true });
    expect(r.handled).toBe(false);
    expect(r.nav2).toEqual([]);
    expect(r.zooms).toEqual([]);
  });
  test("unrelated keys are not handled", () => {
    const r = route({ key: "a", ctrlKey: true }, lin);
    expect(r.handled).toBe(false);
  });
});
