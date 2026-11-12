import { describe, expect, test } from "bun:test";
import { Terminal, WIDE } from "../src/client/term/terminal.ts";

// Editing a line that holds wide characters, zero-width marks at the edge of the used width, and
// IND with a wrap pending. Every case runs through both print paths (ASCII runs on and off).

const mk = (cols: number, rows: number, runs: boolean) => {
  const t = new Terminal(cols, rows, { reply: () => {} });
  t.asciiRuns = runs;
  return t;
};
const row = (t: Terminal, y = 0) => t.lines[y]!.toString();
/** No "" cell without a wide cell before it, and no wide cell without its "" half. */
const wellFormed = (t: Terminal) => {
  for (const l of t.lines) {
    for (let i = 0; i < l.text.length; i++) {
      if (l.text[i] === "" && !(i > 0 && l.fl[i - 1]! & WIDE)) return false;
      if (l.fl[i]! & WIDE && l.text[i + 1] !== "") return false;
    }
  }
  return true;
};

for (const runs of [true, false]) {
  describe(`asciiRuns=${runs}`, () => {
    test("ICH in front of a wide character keeps it", () => {
      const t = mk(8, 1, runs);
      t.write("中x\r\x1b[@");
      expect(row(t)).toBe(" 中x");
      expect(wellFormed(t)).toBe(true);
    });

    test("insert mode in front of a wide character keeps it", () => {
      const t = mk(8, 1, runs);
      t.write("中x\r\x1b[4hA");
      expect(row(t)).toBe("A中x");
      expect(wellFormed(t)).toBe(true);
    });

    test("ICH keeps the narrow cell shifted next to a wide one", () => {
      const t = mk(8, 1, runs);
      t.write("a中x\r\x1b[2@");
      expect(row(t)).toBe("  a中x");
      expect(wellFormed(t)).toBe(true);
    });

    test("ICH still blanks a wide character pushed half off the right edge, with the cursor's background", () => {
      const t = mk(4, 1, runs);
      t.write("ab中\r\x1b[41m\x1b[@");
      expect(row(t)).toBe(" ab");
      expect(t.lines[0]!.bg[0]).not.toBe(t.lines[0]!.bg[1]);
      expect(wellFormed(t)).toBe(true);
    });

    test("DCH that ends inside a wide character leaves no orphan half", () => {
      const t = mk(8, 1, runs);
      t.write("中bc\x1b[1G\x1b[1P");
      expect(t.lines[0]!.text.slice(0, 3)).toEqual([" ", "b", "c"]);
      expect(wellFormed(t)).toBe(true);
      const u = mk(8, 1, runs);
      u.write("a中bc\x1b[1G\x1b[2P");
      expect(row(u)).toBe(" bc");
      expect(wellFormed(u)).toBe(true);
    });

    test("a combining mark on a blank cell past the used width is part of the line, and does not survive recycling", () => {
      const t = mk(20, 3, runs);
      t.write("\x1b[1;10H\u0301");
      expect(row(t)).toBe(" ".repeat(8) + " \u0301");
      t.write("\x1b[3;1H\n\n\n\n\n\n\n");
      expect(t.lines.every((l) => l.text.every((c) => c === " "))).toBe(true);
    });

    test("a glyph after ZWJ does not join a cell on another line, or one that was erased", () => {
      const t = mk(10, 2, runs);
      t.write("\x1b[2;1Hab\u200D\nX");
      expect(row(t, 0)).toBe("ab\u200D");
      expect(row(t, 1)).toBe("  X");
      expect(t.cur.x).toBe(3);
      const u = mk(10, 2, runs);
      u.write("ab\u200D\x1b[2KX");
      expect(row(u)).toBe("  X");
      expect(u.cur.x).toBe(3);
    });

    test("an emoji ZWJ sequence still joins into one cell", () => {
      const t = mk(10, 1, runs);
      t.write("\u{1F468}\u200D\u{1F469}x");
      expect(t.lines[0]!.text[0]).toBe("\u{1F468}\u200D\u{1F469}");
      expect(row(t)).toBe("\u{1F468}\u200D\u{1F469}x");
    });

    test("IND cancels a pending wrap, as LF does", () => {
      for (const ind of ["\x1bD", "\u0084"]) {
        const t = mk(5, 5, runs);
        t.write(`abcde${ind}X`);
        const lf = mk(5, 5, runs);
        lf.write("abcde\nX");
        expect(t.lines.map((l) => l.toString())).toEqual(lf.lines.map((l) => l.toString()));
        expect([t.cur.x, t.cur.y]).toEqual([lf.cur.x, lf.cur.y]);
        expect(t.lines[1]!.wrapped).toBe(false);
      }
    });
  });
}

for (const runs of [true, false]) {
  describe(`parser details, asciiRuns=${runs}`, () => {
    test("DEL inside an escape or control sequence is ignored (VT500)", () => {
      const t = mk(20, 1, runs);
      t.write("\x1b[3\x7f1mA");
      const plain = mk(20, 1, runs);
      plain.write("\x1b[31mA");
      expect(t.lines[0]!.fg[0]).toBe(plain.lines[0]!.fg[0]!);
      const u = mk(20, 1, runs);
      u.write("\x1b\x7f[31mB");
      expect(row(u)).toBe("B");
      expect(u.lines[0]!.fg[0]).toBe(plain.lines[0]!.fg[0]!);
    });

    test("DECALN fills the screen with plain E cells, whatever was there", () => {
      const t = mk(6, 2, runs);
      t.write("\x1b[41m\u4E2Dab\x1b#8");
      expect(t.lines.map((l) => l.toString())).toEqual(["EEEEEE", "EEEEEE"]);
      expect(t.lines[0]!.fl.every((f) => (f & WIDE) === 0)).toBe(true);
      expect(new Set(t.lines[0]!.bg).size).toBe(1);
      expect(t.lines[0]!.bg[0]).toBe(t.lines[1]!.bg[5]!);
    });

    test("REP of an ASCII character matches printing it, attributes and wrap included", () => {
      for (const n of [1, 5, 79, 80, 81, 200, 1925, 70000]) {
        const a = mk(80, 24, runs);
        a.write(`\x1b[1;32m\x1b[3;7Hx\x1b[${n}b`);
        const b = mk(80, 24, runs);
        b.write("\x1b[1;32m\x1b[3;7Hx" + "x".repeat(Math.min(n, 65535) > 1920 ? 1920 + ((Math.min(n, 65535) - 1920) % 80) : n));
        expect([n, a.cur.x, a.cur.y, a.cur.wrapPending]).toEqual([n, b.cur.x, b.cur.y, b.cur.wrapPending]);
        expect([n, ...a.lines.map((l) => l.toString())]).toEqual([n, ...b.lines.map((l) => l.toString())]);
        expect([n, ...a.lines.map((l) => [...l.fg].join())]).toEqual([n, ...b.lines.map((l) => [...l.fg].join())]);
        expect([n, ...a.lines.map((l) => l.wrapped)]).toEqual([n, ...b.lines.map((l) => l.wrapped)]);
      }
    });
  });
}

test("maximal REP of an ASCII character costs well under printing it cell by cell (the replay ring is parsed on every reattach)", () => {
  const data = "x\x1b[65535b".repeat(3000);
  const time = (runs: boolean) => {
    const t = new Terminal(200, 50, { reply: () => {} });
    t.asciiRuns = runs;
    const t0 = performance.now();
    t.write(data);
    return performance.now() - t0;
  };
  // Relative, so a loaded machine does not decide it: about a third in practice.
  const slow = Math.min(time(false), time(false));
  const fast = Math.min(time(true), time(true));
  expect(fast).toBeLessThan(slow * 0.7);
});
