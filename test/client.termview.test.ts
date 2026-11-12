import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installDom, uninstallDom, FakeElement, FakeEvent } from "./helpers/fakedom.ts";

// TerminalView per-frame work: the scrollbar must not force a layout every frame, and the
// screen-reader log must not stringify output it will drop.

let View: typeof import("../src/client/term/view.ts").TerminalView;
let raf: (() => void)[] = [];
let observers: (() => void)[] = [];
const G = ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
const saved: Record<string, PropertyDescriptor | undefined> = {};
let savedGetContext: PropertyDescriptor | undefined;

beforeAll(async () => {
  const dom = installDom({ platform: "MacIntel" });
  for (const k of G) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const set = (k: string, v: unknown) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  set("requestAnimationFrame", (f: () => void) => raf.push(f));
  set("cancelAnimationFrame", () => {});
  set(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
    },
  );
  (dom.window as unknown as { devicePixelRatio: number }).devicePixelRatio = 1;
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (o, k) => (k in o ? o[k] : k === "measureText" ? () => ({ width: 8 }) : () => {}),
    set: (o, k, v) => ((o[k] = v), true),
  });
  savedGetContext = Object.getOwnPropertyDescriptor(FakeElement.prototype, "getContext");
  (FakeElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ctx;
  ({ TerminalView: View } = await import("../src/client/term/view.ts?termview"));
});
afterAll(() => {
  if (savedGetContext) Object.defineProperty(FakeElement.prototype, "getContext", savedGetContext);
  else delete (FakeElement.prototype as unknown as { getContext?: unknown }).getContext;
  for (const k of G) {
    const d = saved[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as Record<string, unknown>)[k];
  }
  uninstallDom();
});

const frame = () => {
  const q = raf;
  raf = [];
  for (const f of q) f();
};

function mk() {
  observers = [];
  const v = new View({
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 1.2,
    theme: { fg: "#ccc", bg: "#111", cursor: "#fff", cursorText: "#000", selection: "#333", link: "#58f", ansi: Array(16).fill("#888") },
    send: () => {},
    resize: () => {},
  });
  const priv = v as unknown as { scrollbar: FakeElement; thumb: FakeElement; log: FakeElement };
  let reads = 0;
  Object.defineProperty(priv.scrollbar, "clientHeight", { get: () => (reads++, 200), configurable: true });
  let writes = 0;
  const style = priv.thumb.style as Record<string, string>;
  for (const k of ["height", "transform"]) {
    let val = "";
    Object.defineProperty(style, k, { get: () => val, set: (x: string) => ((val = x), writes++), configurable: true });
  }
  frame();
  return { v, priv, reads: () => reads, writes: () => writes };
}

describe("terminal scrollbar", () => {
  test("measures the track once, not every frame, and again after a resize", () => {
    const { v, reads } = mk();
    for (let i = 0; i < 40; i++) {
      v.write(`line ${i}\r\n`);
      frame();
    }
    expect(reads()).toBe(1);
    observers[0]!();
    v.write("more\r\n");
    frame();
    expect(reads()).toBe(2);
  });

  test("a frame that does not move the thumb writes no style", () => {
    const { v, writes } = mk();
    v.write("x\r\n".repeat(60));
    frame();
    const before = writes();
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      v.write(`\r\x1b[2Kspinner ${i}`); // redraws a row in place: history does not grow
      frame();
    }
    expect(writes()).toBe(before);
  });

  test("hidden in the alternate screen, with one style write rather than one per frame", () => {
    const { v, priv } = mk();
    v.write("x\r\n".repeat(60));
    frame();
    let n = 0;
    const style = priv.scrollbar.style as Record<string, string>;
    let val = style.display ?? "";
    Object.defineProperty(style, "display", { get: () => val, set: (x: string) => ((val = x), n++), configurable: true });
    v.write("\x1b[?1049h");
    for (let i = 0; i < 20; i++) {
      v.write(`\x1b[H frame ${i}`);
      frame();
    }
    expect(val).toBe("none");
    expect(n).toBe(1);
  });
});

describe("terminal visibility and the screen-reader log", () => {
  test("a hidden view neither paints nor logs; showing it paints", () => {
    const { v, priv } = mk();
    v.setVisible(false);
    v.write("busy\r\n".repeat(100));
    expect(raf.length).toBe(0);
    expect((priv.log as unknown as { children: unknown[] }).children.length).toBe(0);
    v.setVisible(true);
    expect(raf.length).toBe(1);
    frame();
    expect(v.renderer.rowsPainted).toBeGreaterThan(0);
  });

  // WebKit has no contextrestored: coming back is the only signal that pixels may be gone.
  test("returning to the window or tab repaints every row, not only the ones that change", () => {
    const { v } = mk();
    v.write("some output\r\n");
    frame();
    frame();
    for (const fire of [
      () => window.dispatchEvent(new FakeEvent("focus")),
      () => document.dispatchEvent(new FakeEvent("visibilitychange")),
    ]) {
      v.renderer.rowsPainted = 0;
      fire();
      frame();
      expect(v.renderer.rowsPainted).toBe(v.term.rows);
    }
    v.dispose();
  });

  // If the canvas was discarded its context state went too: unset, the cached font and spacing lie.
  test("returning to the window restores the canvas settings, not only the pixels", () => {
    const { v } = mk();
    frame();
    const ctx = (v.renderer as unknown as { ctx: { font: string } }).ctx;
    ctx.font = "10px sans-serif";
    window.dispatchEvent(new FakeEvent("focus"));
    expect(ctx.font).not.toBe("10px sans-serif");
    v.dispose();
  });

  test("a page going into the background, or a disposed view, does not repaint", () => {
    const { v } = mk();
    frame();
    frame();
    v.renderer.rowsPainted = 0;
    const proto = Object.getPrototypeOf(document);
    Object.defineProperty(proto, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new FakeEvent("visibilitychange"));
    } finally {
      delete proto.visibilityState;
    }
    frame();
    expect(v.renderer.rowsPainted).toBe(0);
    v.dispose();
    window.dispatchEvent(new FakeEvent("focus"));
    frame();
    expect(v.renderer.rowsPainted).toBe(0);
  });

  test("a burst of output keeps the newest 200 lines in the log", () => {
    const { v, priv } = mk();
    let s = "";
    for (let i = 0; i < 5000; i++) s += `out ${i}\r\n`;
    v.write(s);
    frame();
    const kids = (priv.log as unknown as { children: { textContent: string }[] }).children;
    expect(kids.length).toBe(200);
    expect(kids[0]!.textContent).toBe("out 4800");
    expect(kids[199]!.textContent).toBe("out 4999");
  });
});

describe("terminal panel drives which terminal paints", () => {
  test("only the active terminal of an open panel is visible to its renderer", async () => {
    const savedWs = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", {
      value: class {
        static OPEN = 1;
        readyState = 0;
        binaryType = "";
        constructor(public url: string) {}
        send() {}
        close() {}
      },
      configurable: true,
      writable: true,
    });
    const proto = FakeElement.prototype as unknown as { querySelector: (s: string) => unknown };
    // Tab markup is set with innerHTML, which the fake DOM does not parse: give it a close button.
    const qs = proto.querySelector;
    proto.querySelector = function (this: unknown, sel: string) {
      return qs.call(this, sel) ?? (sel === ".tab-close" ? { addEventListener() {} } : null);
    };
    try {
      const { TerminalPanel } = await import("../src/client/terminals.ts?termview");
      const theme = { fg: "#ccc", bg: "#111", cursor: "#fff", cursorText: "#000", selection: "#333", link: "#58f", ansi: Array(16).fill("#888") };
      const panel = new TerminalPanel(
        () => theme,
        { family: "monospace", size: 13, lineHeight: 1.2 },
        "zsh",
        { togglePosition() {}, toggleMaximize() {}, hide() {} },
        () => {},
        () => {},
      );
      const visible = (s: { view: { renderer: unknown } }) => (s.view.renderer as { visible: boolean }).visible;
      panel.setShown(false); // the app starts with the panel closed
      const a = panel.create();
      expect(visible(a)).toBe(false);
      panel.setShown(true);
      expect(visible(a)).toBe(true);
      const b = panel.create();
      expect([visible(a), visible(b)]).toEqual([false, true]);
      panel.activate(a);
      expect([visible(a), visible(b)]).toEqual([true, false]);
      panel.setShown(false);
      expect([visible(a), visible(b)]).toEqual([false, false]);
      expect(panel.el.hidden).toBe(true);
    } finally {
      raf = [];
      proto.querySelector = qs;
      if (savedWs) Object.defineProperty(globalThis, "WebSocket", savedWs);
      else delete (globalThis as Record<string, unknown>).WebSocket;
    }
  });
});

describe("output while no frame runs (occluded window, background tab)", () => {
  test("lines waiting for the screen-reader log are bounded", () => {
    const { v } = mk();
    for (let i = 0; i < 300; i++) v.write(`line ${i}\r\n`.repeat(100)); // no frame() in between
    const pending = (v as unknown as { pendingLines: string[] }).pendingLines;
    expect(pending.length).toBeLessThanOrEqual(400);
    expect(pending.at(-1)).toBe("line 299");
    frame();
  });
});

describe("synchronized output (mode 2026) that is never switched off", () => {
  test("after the one-second hold the terminal paints every frame again", () => {
    const { v } = mk();
    const real = performance.now;
    let now = 1000;
    performance.now = () => now;
    const timers: (() => void)[] = [];
    const realTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: unknown }).setTimeout = (f: () => void) => (timers.push(f), 0);
    const tick = (ms: number) => {
      now += ms;
      for (const f of timers.splice(0)) f();
      frame();
    };
    try {
      v.write("\x1b[?2026h"); // a TUI killed mid-frame never sends ?2026l
      tick(0);
      const held = v.renderer.rowsPainted;
      v.write("a");
      tick(500);
      expect(v.renderer.rowsPainted).toBe(held); // still held within the second
      tick(600);
      const first = v.renderer.rowsPainted;
      expect(first).toBeGreaterThan(held);
      // The shell echoes a keystroke 20 ms later: it must show now, not a second from now.
      v.write("b");
      tick(20);
      expect(v.renderer.rowsPainted).toBeGreaterThan(first);
      // A program that does use the mode gets its hold back with the next ?2026h.
      v.write("\x1b[?2026hc");
      const before = v.renderer.rowsPainted;
      tick(20);
      expect(v.renderer.rowsPainted).toBe(before);
      v.write("\x1b[?2026l");
      tick(20);
      expect(v.renderer.rowsPainted).toBeGreaterThan(before);
    } finally {
      performance.now = real;
      globalThis.setTimeout = realTimeout;
    }
  });
});

describe("OSC 52 bursts", () => {
  test("many clipboard writes in one batch of output become one write (the last) and one toast", async () => {
    const writes: string[] = [];
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(nav, "clipboard");
    Object.defineProperty(nav, "clipboard", { value: { writeText: async (t: string) => void writes.push(t) }, configurable: true });
    try {
      const { v } = mk();
      v.write("\x1b]52;c;QQ==\x07".repeat(5000) + "\x1b]52;c;Qg==\x07");
      await new Promise((r) => setTimeout(r, 10));
      expect(writes).toEqual(["B"]);
      v.write("\x1b]52;c;Qw==\x07"); // a later batch is its own write
      await new Promise((r) => setTimeout(r, 10));
      expect(writes).toEqual(["B", "C"]);
    } finally {
      if (had) Object.defineProperty(nav, "clipboard", had);
      else delete nav.clipboard;
    }
  });
});
