import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installDom, uninstallDom, FakeElement } from "./helpers/fakedom.ts";

// TerminalView per-frame work: the scrollbar must not force a layout every frame, and the
// screen-reader log must not stringify output it will drop.

let View: typeof import("../src/client/term/view.ts").TerminalView;
let raf: (() => void)[] = [];
let observers: (() => void)[] = [];
const G = ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"] as const;
const saved: Record<string, PropertyDescriptor | undefined> = {};

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
  (FakeElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ctx;
  ({ TerminalView: View } = await import("../src/client/term/view.ts?termview"));
});
afterAll(() => {
  delete (FakeElement.prototype as unknown as { getContext?: unknown }).getContext;
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
