import { describe, expect, test } from "bun:test";
import { createHiddenNav } from "../src/client/hiddennav.ts";

const ZW = "\u200B";
const WJ = "\u2060";
// Hits: (2,1) (4,1) (4,3) (6,2); lines 1, 3, 5 and 7 are clean.
const LINES = ["a", ZW + "b", "c", ZW + "d" + WJ, "e", "f" + ZW, "g"];

/** A host whose position is the editor's: a line (1-based, as Editor.location() reports it); a jump moves it. */
const mk = (lines: readonly string[] = LINES) => {
  const state = { line: 1, col: undefined as number | undefined };
  const log = { reveal: [] as number[], announce: [] as string[], toast: [] as string[] };
  const host = {
    lines: () => lines,
    position: () => (state.col === undefined ? { line: state.line } : { line: state.line, col: state.col }),
    reveal: (l: number) => {
      log.reveal.push(l);
      state.line = l + 1;
      state.col = undefined;
    },
    announce: (m: string) => void log.announce.push(m),
    toast: (m: string) => void log.toast.push(m),
  };
  return { nav: createHiddenNav(host as never), log, state };
};

describe("the command starts from the editor's current position", () => {
  test("after the position moves to line 3 (search, Go to Line, a click) the next hit is the first after it", () => {
    const { nav, log, state } = mk();
    nav.next();
    expect(log.announce[0]).toBe("U+200B ZERO WIDTH SPACE at line 2, column 1");
    state.line = 3;
    nav.next();
    expect(log.announce[1]).toBe("U+200B ZERO WIDTH SPACE at line 4, column 1");
    expect(log.reveal[1]).toBe(3);
    state.line = 5; // a search lands past the module's own last jump
    nav.next();
    expect(log.announce[2]).toBe("U+200B ZERO WIDTH SPACE at line 6, column 2");
  });
  test("moving back after a jump is honoured, not the last jump", () => {
    const { nav, log, state } = mk();
    nav.next();
    nav.next();
    state.line = 1;
    nav.next();
    expect(log.announce[2]).toBe("U+200B ZERO WIDTH SPACE at line 2, column 1");
  });
  test("a fresh press from a position before any hit finds the first hit", () => {
    const { nav, log } = mk();
    nav.next();
    expect(log.announce).toEqual(["U+200B ZERO WIDTH SPACE at line 2, column 1"]);
  });
  test("repeated presses advance, including two hits on one line, and wrap", () => {
    const { nav, log } = mk();
    for (let i = 0; i < 5; i++) nav.next();
    expect(log.announce).toEqual([
      "U+200B ZERO WIDTH SPACE at line 2, column 1",
      "U+200B ZERO WIDTH SPACE at line 4, column 1",
      "U+2060 WORD JOINER at line 4, column 3",
      "U+200B ZERO WIDTH SPACE at line 6, column 2",
      "U+200B ZERO WIDTH SPACE at line 2, column 1",
    ]);
  });
  test("a position past the last hit wraps to the first", () => {
    const { nav, log, state } = mk();
    state.line = 7;
    nav.next();
    expect(log.announce).toEqual(["U+200B ZERO WIDTH SPACE at line 2, column 1"]);
  });
  test("a provider that knows the column starts after that column", () => {
    const { nav, log, state } = mk();
    state.line = 4;
    state.col = 1;
    nav.next();
    expect(log.announce).toEqual(["U+2060 WORD JOINER at line 4, column 3"]);
  });
  test("a different file starts from its own position", () => {
    const a = mk();
    a.nav.next();
    a.nav.next();
    const b = mk(["x", ZW, "y"]);
    b.state.line = 1;
    b.nav.next();
    expect(b.log.announce).toEqual(["U+200B ZERO WIDTH SPACE at line 2, column 1"]);
  });
});
