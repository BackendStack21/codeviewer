import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Terminal } from "../src/client/term/terminal.ts";

// Long agent sessions (Claude Code and other TUIs) redraw constantly and can print a lot: these
// pin the work the emulator and renderer skip, and that skipping changes nothing visible.

function snapshot(t: Terminal) {
  const dump = (l: { text: string[]; fg: Int32Array; bg: Int32Array; fl: Uint32Array; wrapped: boolean; hw: number }) =>
    JSON.stringify([l.text, [...l.fg], [...l.bg], [...l.fl], l.wrapped, l.hw]);
  return {
    lines: t.lines.map(dump),
    scrollback: t.scrollback.map(dump),
    cur: { ...t.cur, charsets: [...t.cur.charsets] },
    dirty: [...t.dirty],
  };
}

describe("ASCII runs (write fast path)", () => {
  // Deterministic PRNG so a failure reproduces.
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pieces = [
    "hello", "a", " ", "world wide web ", "x".repeat(37), "\r\n", "\n", "\r", "\t", "\b",
    "日本", "😀", "é", "👩‍💻", "‍z", "│", "\x1b[31m", "\x1b[1;4m", "\x1b[0m",
    "\x1b[?7l", "\x1b[?7h", "\x1b[4h", "\x1b[4l", "\x1b(0", "\x1b(B", "lqk", "\x1b[3D", "\x1b[2C",
    "\x1b[H", "\x1b[5;3H", "\x1b[K", "\x1b[2J", "\x1b[1P", "\x1b[2@", "\x1b[S", "\x1b[2;4r", "\x1b[r",
    "\x1b]8;;https://a.example\x07link\x1b]8;;\x07", "\x0e", "\x0f", "\x1b[?1049h", "\x1b[?1049l",
  ];

  test("produces exactly the same screen, history and cursor as printing one character at a time", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      let s = "";
      for (let i = 0; i < 400; i++) s += pieces[Math.floor(r() * pieces.length)]!;
      const cols = 5 + Math.floor(r() * 30);
      const rows = 2 + Math.floor(r() * 6);
      const fast = new Terminal(cols, rows, { reply: () => {} });
      const slow = new Terminal(cols, rows, { reply: () => {} });
      slow.asciiRuns = false;
      // Split at random points: runs may straddle writes.
      let at = 0;
      while (at < s.length) {
        const n = 1 + Math.floor(r() * 50);
        fast.write(s.slice(at, at + n));
        slow.write(s.slice(at, at + n));
        at += n;
      }
      expect({ seed, ...snapshot(fast) }).toEqual({ seed, ...snapshot(slow) });
    }
  });

  test("a run that reaches the margin wraps (or, without autowrap, overwrites the last column)", () => {
    const t = new Terminal(5, 3, { reply: () => {} });
    t.write("abcdefgh");
    expect(t.lines[0]!.toString()).toBe("abcde");
    expect(t.lines[0]!.wrapped).toBe(true);
    expect(t.lines[1]!.toString()).toBe("fgh");
    t.write("\x1b[?7l\x1b[3;1Hvwxyz123");
    expect(t.lines[2]!.toString()).toBe("vwxy3");
  });

  test("a run over half of a wide character blanks its other half", () => {
    const t = new Terminal(6, 2, { reply: () => {} });
    // 日 本 語 fill columns 0-5; "ab" at column 1 splits 日 (left edge) and 本 (right edge).
    t.write("日本語\x1b[1;2Hab");
    expect(t.lines[0]!.text.join("|")).toBe(" |a|b| |語|");
  });
});

describe("completed lines for assistive technology: lazy and capped", () => {
  const mk = (cols = 20, rows = 4, limit = Infinity) => {
    const lines: string[] = [];
    const t = new Terminal(cols, rows, { reply: () => {}, onLine: (s) => lines.push(s) });
    t.announceLimit = limit;
    return { t, lines };
  };

  test("a burst reports only the newest announceLimit lines, in order", () => {
    const { t, lines } = mk(20, 4, 3);
    let s = "";
    for (let i = 0; i < 1000; i++) s += `line ${i}\r\n`;
    t.write(s);
    expect(lines).toEqual(["line 997", "line 998", "line 999"]);
  });

  test("lines are stringified only for the reports that are kept", () => {
    const { t } = mk(20, 4, 5);
    let s = "";
    for (let i = 0; i < 2000; i++) s += `line ${i}\r\n`;
    const proto = Object.getPrototypeOf(t.lines[0]!) as { toString(): string };
    const orig = proto.toString;
    let calls = 0;
    proto.toString = function (this: unknown) {
      calls++;
      return orig.call(this);
    };
    try {
      t.write(s);
    } finally {
      proto.toString = orig;
    }
    expect(calls).toBe(5);
  });

  test("a line redrawn within one write is reported once, as it finally reads", () => {
    const { t, lines } = mk();
    // The TUI pattern: print, line feed, then go back up, erase and redraw before the frame ends.
    t.write("Working 1\r\n\x1b[1A\x1b[2KWorking 2\r\n");
    expect(lines).toEqual(["Working 2"]);
  });

  test("a line scrolled out of a margin region keeps its text after the screen line is reused", () => {
    const { t, lines } = mk(20, 4);
    t.write("\x1b[2;4r\x1b[4;1Hfirst\r\nsecond\r\n");
    expect(lines).toEqual(["first", "second"]);
  });

  test("a line scrolled into history keeps its text after the screen line is reused", () => {
    const { t, lines } = mk(20, 2);
    t.write("a\r\nb\r\nc\r\nd\r\n");
    expect(lines).toEqual(["a", "b", "c", "d"]);
    expect(t.scrollback.map((l) => l.toString())).toEqual(["a", "b", "c"]);
  });
});

describe("renderer: repaints only what changed, and nothing while hidden", () => {
  type R = import("../src/client/term/renderer.ts").Renderer;
  let Renderer: typeof import("../src/client/term/renderer.ts").Renderer;
  let raf: (() => void)[] = [];
  const canvasListeners = new Map<string, () => void>();
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const G = ["document", "window", "requestAnimationFrame", "cancelAnimationFrame"] as const;

  beforeAll(async () => {
    for (const k of G) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (o, k) => (k in o ? o[k] : k === "measureText" ? () => ({ width: 8 }) : () => {}),
      set: (o, k, v) => ((o[k] = v), true),
    });
    const set = (k: string, v: unknown) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    set("document", {
      createElement: () => ({
        getContext: () => ctx,
        setAttribute() {},
        style: {},
        addEventListener(type: string, fn: () => void) {
          canvasListeners.set(type, fn);
        },
      }),
    });
    set("window", { devicePixelRatio: 1 });
    set("requestAnimationFrame", (f: () => void) => raf.push(f));
    set("cancelAnimationFrame", (id: number) => {
      raf[id - 1] = () => {};
    });
    ({ Renderer } = await import("../src/client/term/renderer.ts"));
  });
  afterAll(() => {
    for (const k of G) {
      const d = saved[k];
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  });

  const frame = () => {
    const q = raf;
    raf = [];
    for (const f of q) f();
  };
  const mk = (cols = 30, rows = 10) => {
    const t = new Terminal(cols, rows, { reply: () => {} });
    const r: R = new Renderer(t);
    r.setTheme({ fg: "#ccc", bg: "#111", cursor: "#fff", cursorText: "#000", selection: "#333", link: "#58f", ansi: Array(16).fill("#888") });
    r.setFont("monospace", 13, 1.2);
    r.resizeCanvas();
    frame();
    r.rowsPainted = 0;
    return { t, r };
  };
  const write = (t: Terminal, r: R, s: string) => {
    t.write(s);
    r.schedule();
    frame();
    const n = r.rowsPainted;
    r.rowsPainted = 0;
    return n;
  };
  // An Ink-style status region: erase the lines upward, then print them all again.
  const region = (tick: number) => "\x1b[2K\x1b[1A".repeat(4) + "\x1b[2K\r" + `spin ${tick}\r\n` + "same 1\r\nsame 2\r\nsame 3\r\n> ";

  test("a full redraw of identical rows repaints only the rows whose cells changed", () => {
    const { t, r } = mk();
    write(t, r, "\r\n".repeat(3) + region(0));
    expect(write(t, r, region(1))).toBe(1); // only the spinner row (the cursor stays put)
    expect(write(t, r, region(1))).toBe(0);
  });

  test("clearing and repainting the whole screen with the same content paints nothing", () => {
    const { t, r } = mk();
    const screen = "\x1b[H\x1b[2J" + Array.from({ length: 9 }, (_, i) => `row ${i}`).join("\r\n");
    write(t, r, screen);
    expect(write(t, r, screen)).toBe(0);
  });

  test("cursor moves, selection and colour changes still repaint their rows", () => {
    const { t, r } = mk();
    write(t, r, "abc\r\ndef");
    expect(write(t, r, "\x1b[1;1H")).toBe(2); // the row the cursor left and the row it entered
    expect(write(t, r, "\x1b[31mabc")).toBe(1); // same text, new colour
    r.selection = { a: { row: 1, col: 0 }, b: { row: 1, col: 1 } };
    r.touchAll();
    frame();
    expect(r.rowsPainted).toBe(1);
  });

  test("invalidate (theme, font, resize) repaints every row", () => {
    const { t, r } = mk();
    r.invalidate();
    frame();
    expect(r.rowsPainted).toBe(t.rows);
  });

  test("a hidden renderer requests no frames; showing it repaints everything once", () => {
    const { t, r } = mk();
    r.setVisible(false);
    t.write("output while hidden\r\n".repeat(50));
    r.schedule();
    expect(raf.length).toBe(0);
    r.setVisible(true);
    frame();
    expect(r.rowsPainted).toBe(t.rows);
  });

  test("a restored canvas context (its pixels were discarded) repaints every row", () => {
    const { t, r } = mk();
    write(t, r, "content\r\n".repeat(5));
    canvasListeners.get("contextrestored")!();
    frame();
    expect(r.rowsPainted).toBe(t.rows);
  });

  test("hiding cancels a frame already requested", () => {
    const { t, r } = mk();
    t.write("x");
    r.schedule();
    r.setVisible(false);
    frame();
    expect(r.rowsPainted).toBe(0);
  });
});
