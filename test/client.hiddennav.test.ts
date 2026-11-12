import { describe, expect, test } from "bun:test";
import { createHiddenNav, type HiddenNavHost } from "../src/client/hiddennav.ts";

const ZW = "\u200B";
const mk = (lines: readonly string[] | null) => {
  const log = { reveal: [] as number[], announce: [] as string[], toast: [] as string[] };
  const state = { lines };
  const host: HiddenNavHost = {
    lines: () => state.lines,
    reveal: (l) => void log.reveal.push(l),
    announce: (m) => void log.announce.push(m),
    toast: (m) => void log.toast.push(m),
  };
  return { nav: createHiddenNav(host), log, state };
};
const TEXT = ["a", ZW + "b", "c\u2060"];

describe("AC-20 Go to Next Hidden Character", () => {
  test("walks the hits in order and wraps, announcing each", () => {
    const { nav, log } = mk(TEXT);
    nav.next();
    expect(log.announce).toEqual(["U+200B ZERO WIDTH SPACE at line 2, column 1"]);
    expect(log.reveal).toEqual([1]);
    nav.next();
    expect(log.announce[1]).toBe("U+2060 WORD JOINER at line 3, column 2");
    expect(log.reveal[1]).toBe(2);
    nav.next();
    expect(log.announce[2]).toBe("U+200B ZERO WIDTH SPACE at line 2, column 1");
    expect(log.reveal[2]).toBe(1);
    expect(log.toast).toEqual([]);
  });
  test("bidi controls are navigable too", () => {
    const { nav, log } = mk(["x\u202Ey"]);
    nav.next();
    expect(log.announce).toEqual(["U+202E BIDI CONTROL at line 1, column 2"]);
  });
  test("a position set by another reveal is the starting point", () => {
    const { nav, log } = mk(TEXT);
    nav.seen(2); // 0-based line 2 is line 3
    nav.next();
    expect(log.announce).toEqual(["U+2060 WORD JOINER at line 3, column 2"]);
    nav.seen(0);
    nav.next();
    expect(log.announce[1]).toBe("U+200B ZERO WIDTH SPACE at line 2, column 1");
  });
});

describe("AC-21 nothing to go to", () => {
  test("a file without hidden characters toasts and does not move", () => {
    const { nav, log } = mk(["plain", "text \u200E"]);
    nav.next();
    expect(log.toast).toEqual(["No hidden characters in this file"]);
    expect(log.announce).toEqual([]);
    expect(log.reveal).toEqual([]);
  });
  test("no text file does nothing visible and does not throw", () => {
    const { nav, log } = mk(null);
    expect(() => nav.next()).not.toThrow();
    expect(log.announce).toEqual([]);
    expect(log.reveal).toEqual([]);
  });
});

describe("AC-22 state", () => {
  test("reset() and a different file both start again at (0,0)", () => {
    const { nav, log, state } = mk(TEXT);
    nav.next();
    nav.next();
    nav.reset();
    nav.next();
    expect(log.announce[2]).toBe("U+200B ZERO WIDTH SPACE at line 2, column 1");
    nav.next(); // now at line 3
    state.lines = [...TEXT]; // a freshly opened file
    nav.next();
    expect(log.announce[4]).toBe("U+200B ZERO WIDTH SPACE at line 2, column 1");
  });
  test("every hit is navigable, past the 200 the scanner keeps by default, then it wraps", () => {
    // A cap here hid whatever came after 200 decoys: the walk wrapped to the first hit instead.
    const { nav, log } = mk([ZW.repeat(300)]);
    for (let i = 0; i < 301; i++) nav.next();
    expect(log.announce[0]).toBe("U+200B ZERO WIDTH SPACE at line 1, column 1");
    expect(log.announce[199]).toBe("U+200B ZERO WIDTH SPACE at line 1, column 200");
    expect(log.announce[200]).toBe("U+200B ZERO WIDTH SPACE at line 1, column 201");
    expect(log.announce[299]).toBe("U+200B ZERO WIDTH SPACE at line 1, column 300");
    expect(log.announce[300]).toBe("U+200B ZERO WIDTH SPACE at line 1, column 1");
  });
});
