import { describe, expect, test } from "bun:test";
import { Terminal, BOLD, INVERSE, WIDE, RGB_FLAG, DEFAULT } from "../src/client/term/terminal.ts";

function mk(cols = 20, rows = 5) {
  const replies: string[] = [];
  const t = new Terminal(cols, rows, {
    reply: (d) => replies.push(d),
    colors: () => ({ fg: "#c0c0c0", bg: "#101112", cursor: "#ffffff", palette: ["#000000"] }),
  });
  return { t, replies, row: (y: number) => t.lines[y]!.toString() };
}

describe("terminal emulator", () => {
  test("prints text and handles CR/LF", () => {
    const { t, row } = mk();
    t.write("hello\r\nworld");
    expect(row(0)).toBe("hello");
    expect(row(1)).toBe("world");
    expect([t.cur.x, t.cur.y]).toEqual([5, 1]);
  });

  test("autowrap uses the pending-wrap flag", () => {
    const { t, row } = mk(5, 3);
    t.write("abcde");
    expect([t.cur.x, t.cur.y]).toEqual([4, 0]); // still on the last column
    t.write("f");
    expect(row(0)).toBe("abcde");
    expect(row(1)).toBe("f");
    expect(t.lines[0]!.wrapped).toBe(true);
  });

  test("scrolls into scrollback", () => {
    const { t, row } = mk(10, 3);
    t.write("1\r\n2\r\n3\r\n4\r\n5");
    expect(t.scrollback.map((l) => l.toString())).toEqual(["1", "2"]);
    expect([row(0), row(1), row(2)]).toEqual(["3", "4", "5"]);
  });

  test("cursor movement and erase", () => {
    const { t, row } = mk();
    t.write("abcdefgh\x1b[1;3H\x1b[K");
    expect(row(0)).toBe("ab");
    t.write("\x1b[2;5HX\x1b[1G\x1b[2K");
    expect(row(1)).toBe("");
    t.write("\x1b[3;1H123456\x1b[3;3H\x1b[2P");
    expect(row(2)).toBe("1256");
    t.write("\x1b[3;2H\x1b[2@");
    expect(row(2)).toBe("1  256");
    t.write("\x1b[3;1H\x1b[3X");
    expect(row(2)).toBe("   256");
  });

  test("SGR colors: 16, 256, truecolor (semicolon and colon forms)", () => {
    const { t } = mk();
    t.write("\x1b[1;31mA\x1b[38;5;200mB\x1b[38;2;10;20;30mC\x1b[48:2::1:2:3mD\x1b[7mE\x1b[0mF");
    const l = t.lines[0]!;
    expect(l.fg[0]).toBe(1);
    expect(l.fl[0]! & BOLD).toBeTruthy();
    expect(l.fg[1]).toBe(200);
    expect(l.fg[2]).toBe(RGB_FLAG | (10 << 16) | (20 << 8) | 30);
    expect(l.bg[3]).toBe(RGB_FLAG | (1 << 16) | (2 << 8) | 3);
    expect(l.fl[4]! & INVERSE).toBeTruthy();
    expect(l.fg[5]).toBe(DEFAULT);
    expect(l.fl[5]).toBe(0);
  });

  test("alternate screen preserves the primary screen and cursor", () => {
    const { t, row } = mk();
    t.write("primary\x1b[?1049h");
    expect(t.alt).toBe(true);
    expect(row(0)).toBe("");
    t.write("alt text");
    t.write("\x1b[?1049l");
    expect(t.alt).toBe(false);
    expect(row(0)).toBe("primary");
    expect(t.cur.x).toBe(7);
  });

  test("scroll regions (DECSTBM) with insert/delete lines", () => {
    const { t, row } = mk(10, 5);
    t.write("a\r\nb\r\nc\r\nd\r\ne");
    t.write("\x1b[2;4r\x1b[4;1H\n");
    expect([row(0), row(1), row(2), row(3), row(4)]).toEqual(["a", "c", "d", "", "e"]);
    expect(t.scrollback.length).toBe(0);
    t.write("\x1b[2;1H\x1b[L");
    expect([row(1), row(2), row(3)]).toEqual(["", "c", "d"]);
  });

  test("reverse index scrolls down at the top margin", () => {
    const { t, row } = mk(10, 3);
    t.write("x\r\ny\x1b[H\x1bM");
    expect([row(0), row(1), row(2)]).toEqual(["", "x", "y"]);
  });

  test("wide characters occupy two cells", () => {
    const { t } = mk();
    t.write("a中b");
    const l = t.lines[0]!;
    expect(l.text.slice(0, 4)).toEqual(["a", "中", "", "b"]);
    expect(l.fl[1]! & WIDE).toBeTruthy();
    expect(t.cur.x).toBe(4);
  });

  test("emoji and combining marks", () => {
    const { t } = mk();
    t.write("e\u0301🙂x");
    const l = t.lines[0]!;
    expect(l.text[0]).toBe("e\u0301");
    expect(l.text[1]).toBe("🙂");
    expect(l.text[3]).toBe("x");
  });

  test("answers device queries", () => {
    const { t, replies } = mk();
    t.write("\x1b[3;4H\x1b[6n\x1b[c\x1b[>c\x1b]11;?\x07\x1b[?2026$p");
    expect(replies[0]).toBe("\x1b[3;4R");
    expect(replies[1]).toBe("\x1b[?62;22c");
    expect(replies[2]).toMatch(/^\x1b\[>/);
    expect(replies[3]).toBe("\x1b]11;rgb:1010/1111/1212\x1b\\");
    expect(replies[4]).toBe("\x1b[?2026;2$y");
  });

  test("silent mode suppresses replies (history replay)", () => {
    const { t, replies } = mk();
    t.silent = true;
    t.write("\x1b[6n");
    t.silent = false;
    expect(replies).toEqual([]);
  });

  test("modes: bracketed paste, app cursor, mouse, cursor visibility", () => {
    const { t } = mk();
    t.write("\x1b[?2004h\x1b[?1h\x1b[?1002h\x1b[?1006h\x1b[?25l");
    expect(t.modes.bracketedPaste).toBe(true);
    expect(t.modes.appCursor).toBe(true);
    expect(t.modes.mouse).toBe(1002);
    expect(t.modes.mouseSgr).toBe(true);
    expect(t.modes.cursorVisible).toBe(false);
  });

  test("OSC title and hyperlinks; split escape sequences across writes", () => {
    let title = "";
    const t = new Terminal(20, 3, { reply: () => {}, title: (s) => (title = s) });
    t.write("\x1b]0;my ti");
    t.write("tle\x07\x1b]8;;https://ex");
    t.write("ample.com\x1b\\link\x1b]8;;\x1b\\ no");
    expect(title).toBe("my title");
    const l = t.lines[0]!;
    const id = l.fl[0]! >>> 16;
    expect(t.links[id]).toBe("https://example.com");
    expect(l.fl[5]! >>> 16).toBe(0);
  });

  test("UTF-8 split across chunks", () => {
    const { t } = mk();
    const bytes = new TextEncoder().encode("ñ€");
    t.write(bytes.subarray(0, 1));
    t.write(bytes.subarray(1, 3));
    t.write(bytes.subarray(3));
    expect(t.lines[0]!.toString()).toBe("ñ€");
  });

  test("DEC special graphics charset", () => {
    const { t } = mk();
    t.write("\x1b(0lqk\x1b(Bx");
    expect(t.lines[0]!.toString()).toBe("┌─┐x");
  });

  test("tabs and REP", () => {
    const { t, row } = mk(30, 2);
    t.write("a\tb");
    expect(t.lines[0]!.text[8]).toBe("b");
    t.write("\r\n=\x1b[4b");
    expect(row(1)).toBe("=====");
  });

  test("resize keeps the cursor line visible", () => {
    const { t } = mk(10, 5);
    t.write("1\r\n2\r\n3\r\n4\r\n5");
    t.resize(10, 2);
    expect(t.lines.map((l) => l.toString())).toEqual(["4", "5"]);
    expect(t.cur.y).toBe(1);
    t.resize(10, 5);
    expect(t.lines.map((l) => l.toString())).toEqual(["1", "2", "3", "4", "5"]);
    expect(t.cur.y).toBe(4);
  });

  test("survives garbage input", () => {
    const { t } = mk();
    const junk = Array.from({ length: 5000 }, () => String.fromCharCode(Math.floor(Math.random() * 0x2600))).join("");
    t.write(junk);
    t.write("\x1b[999;999H\x1b[-5A\x1b[?9999h\x1b[38;5m\x1b[48;2m");
    expect(t.cur.x).toBeLessThan(20);
    expect(t.cur.y).toBeLessThan(5);
  });

  // ── regressions from the correctness review ──

  test("ZWJ emoji sequences occupy one wide cell", () => {
    const { t } = mk();
    t.write("👨\u200d👩\u200d👧X");
    expect(t.lines[0]!.text[0]).toBe("👨\u200d👩\u200d👧");
    expect(t.lines[0]!.text[2]).toBe("X");
    expect(t.cur.x).toBe(3);
  });

  test("BS with a pending wrap moves left (xterm)", () => {
    const { t, row } = mk(5, 2);
    t.write("abcde\bX");
    expect(row(0)).toBe("abcXe");
  });

  test("an unterminated OSC/DCS ends at the next escape", () => {
    let title = "";
    const t = new Terminal(20, 2, { reply: () => {}, title: (x) => (title = x) });
    t.write("\x1b]0;title\x1b[31mhello");
    expect(t.lines[0]!.toString()).toBe("hello");
    expect(t.lines[0]!.fg[0]).toBe(1);
    expect(title).toBe("");
    t.write("\r\x1bPq#0;1\x1b[32mok");
    expect(t.lines[0]!.toString()).toBe("okllo");
  });

  test("CAN aborts an OSC string", () => {
    const { t } = mk();
    t.write("\x1b]0;ab\x18cd");
    expect(t.lines[0]!.toString()).toBe("cd");
  });

  test("C1 code points are not printed", () => {
    const { t } = mk();
    t.write("a\u0085b");
    expect(t.lines[0]!.text[0]).toBe("a");
    expect(t.lines[0]!.toString()).not.toContain("\u0085");
  });

  test("CNL/CPL respect margins only inside the scroll region", () => {
    const { t } = mk(10, 8);
    t.write("\x1b[1;3r\x1b[6;1H\x1b[2E");
    expect(t.cur.y).toBe(7);
    t.write("\x1b[3;5r\x1b[1;1H\x1b[2F");
    expect(t.cur.y).toBe(0);
  });

  test("EL clears the pending wrap", () => {
    const { t, row } = mk(5, 2);
    t.write("abcde\x1b[KX");
    expect(row(0)).toBe("abcdX");
    expect(row(1)).toBe("");
  });

  test("erasing half of a wide character erases all of it", () => {
    const { t } = mk(10, 1);
    t.write("a中b\x1b[1;3H\x1b[K");
    const l = t.lines[0]!;
    expect(l.text[1]).toBe(" ");
    expect(l.fl[1]! & WIDE).toBe(0);
  });

  test("1049 restores the charset of the primary screen", () => {
    const { t } = mk();
    t.write("\x1b[?1049h\x1b(0\x1b[?1049lq");
    expect(t.lines[0]!.toString()).toBe("q");
  });

  test("DECSTR keeps bracketed paste and mouse modes", () => {
    const { t } = mk();
    t.write("\x1b[?2004h\x1b[?1000h\x1b[!p");
    expect(t.modes.bracketedPaste).toBe(true);
    expect(t.modes.mouse).toBe(1000);
  });

  test("replayed OSC 52 never touches the clipboard", () => {
    const copies: string[] = [];
    const t = new Terminal(20, 2, { reply: () => {}, clipboard: (x) => copies.push(x) });
    t.silent = true;
    t.write(`\x1b]52;c;${btoa("old")}\x07`);
    t.silent = false;
    t.write(`\x1b]52;c;${btoa("new")}\x07`);
    expect(copies).toEqual(["new"]);
  });
});
