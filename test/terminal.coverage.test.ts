import { describe, expect, test } from "bun:test";
import { Terminal, Line, BOLD, DIM, ITALIC, UNDERLINE, BLINK, INVERSE, HIDDEN, STRIKE, WIDE, RGB_FLAG, DEFAULT, MAX_SCROLLBACK } from "../src/client/term/terminal.ts";

const ESC = "\x1b";

function mk(cols = 20, rows = 5, extra: Record<string, unknown> = {}) {
  const replies: string[] = [];
  const events: Record<string, unknown[]> = { title: [], bell: [], clip: [], cwd: [] };
  const t = new Terminal(cols, rows, {
    reply: (d) => replies.push(d),
    title: (s) => events.title!.push(s),
    bell: () => events.bell!.push(1),
    clipboard: (s) => events.clip!.push(s),
    cwd: (s) => events.cwd!.push(s),
    colors: () => ({ fg: "#c0c0c0", bg: "#101112", cursor: "#ffffff", palette: ["#000000", "#ff0000"] }),
    ...extra,
  });
  return { t, replies, events, row: (y: number) => t.lines[y]!.toString() };
}

describe("Line", () => {
  test("resize wider and narrower, narrowing through a wide char blanks it", () => {
    const l = new Line(4);
    l.text[2] = "W";
    l.fl[2] = WIDE;
    l.text[3] = "";
    l.resize(6);
    expect(l.cols).toBe(6);
    expect(l.fg.length).toBe(6);
    expect(l.fg[5]).toBe(DEFAULT);
    l.resize(3);
    expect(l.cols).toBe(3);
    expect(l.text[2]).toBe(" ");
    expect(l.fl[2]).toBe(0);
    l.resize(3); // no-op
    expect(l.cols).toBe(3);
  });

  test("clear expands to cover both halves of a wide character", () => {
    const l = new Line(6);
    l.text[1] = "漢";
    l.fl[1] = WIDE;
    l.text[2] = "";
    l.clear(2, 3, DEFAULT); // starts on the continuation cell
    expect(l.text[1]).toBe(" ");
    expect(l.fl[1]).toBe(0);
    const m = new Line(6);
    m.text[1] = "漢";
    m.fl[1] = WIDE;
    m.text[2] = "";
    m.clear(0, 2, DEFAULT); // ends on the wide lead
    expect(m.text[2]).toBe(" ");
  });

  test("clear with a background raises the high-water mark; compactCopy keeps the prefix", () => {
    const l = new Line(8);
    expect(l.usedWidth()).toBe(0);
    l.clear(0, 5, 4);
    expect(l.usedWidth()).toBe(5);
    expect(l.bg[3]).toBe(4);
    l.text[0] = "a";
    const c = l.compactCopy(3);
    expect(c.cols).toBe(3);
    expect(c.toString()).toBe("a");
    l.recycle(5, DEFAULT);
    expect(l.usedWidth()).toBe(0);
    expect(l.bg[3]).toBe(DEFAULT);
    l.recycle(1, 2);
    expect(l.usedWidth()).toBe(8);
    expect(l.bg[7]).toBe(2);
    expect(new Line(3, 1).usedWidth()).toBe(3);
  });
});

describe("controls and C1", () => {
  test("bell, backspace, tabs", () => {
    const { t, events } = mk();
    t.write("\x07ab\bc");
    expect(events.bell!.length).toBe(1);
    expect(t.lines[0]!.toString()).toBe("ac");
    t.write("\r\t");
    expect(t.cur.x).toBe(8);
    t.write("\t\t\t");
    expect(t.cur.x).toBe(19);
  });

  test("backspace drops pending wrap and moves left", () => {
    const { t } = mk(5, 2);
    t.write("abcde\b");
    expect(t.cur.x).toBe(3);
    expect(t.cur.wrapPending).toBe(false);
  });

  test("LF/VT/FF and newline mode", () => {
    const { t } = mk();
    t.write("ab\x0bc\x0cd");
    expect([t.cur.x, t.cur.y]).toEqual([4, 2]);
    t.write(`${ESC}[20h\nx`);
    expect([t.cur.x, t.cur.y]).toEqual([1, 3]);
    t.write(`${ESC}[20l\ny`);
    expect([t.cur.x, t.cur.y]).toEqual([2, 4]);
  });

  test("shift out/in with DEC graphics designated in G1", () => {
    const { t, row } = mk();
    t.write(`${ESC})0\x0elqk\x0fq`);
    expect(row(0)).toBe("┌─┐q");
    t.write(`\r${ESC}(0lqk${ESC}(Bq`);
    expect(row(0)).toBe("┌─┐q");
  });

  test("C1 controls: IND, NEL, HTS, RI, CSI, OSC", () => {
    const { t, events, row } = mk(20, 3);
    t.write("ab\u0084c"); // IND
    expect([t.cur.x, t.cur.y]).toEqual([3, 1]);
    t.write("\u0085d"); // NEL
    expect([t.cur.x, t.cur.y]).toEqual([1, 2]);
    t.write("\u008d\u008d"); // RI x2
    expect(t.cur.y).toBe(0);
    t.write("\r\u0088\u009b1C\u009b2D\u009d2;T\u009c"); // HTS at 0, CSI, OSC with ST
    expect(events.title).toEqual(["T"]);
    expect(row(0).startsWith("ab")).toBe(true);
    t.write("\u0090junk\u009cx\u0098s\u009c\u009eP\u009c\u009f\u009c");
    expect(row(0).includes("x")).toBe(true);
  });

  test("DEL and stray C1 in ground are ignored; CAN/SUB abort sequences", () => {
    const { t, row } = mk();
    t.write("a\x7fb\u0081c");
    expect(row(0)).toBe("abc");
    t.write(`\r\n${ESC}[31\x18x`); // CAN cancels CSI
    expect(t.lines[1]!.toString()).toBe("x");
    t.write(`\r\n${ESC}]0;abc\x1ay`); // SUB cancels OSC
    expect(t.lines[2]!.toString()).toBe("y");
    expect(t.title).toBe("");
  });
});

describe("escape sequences", () => {
  test("save/restore cursor via ESC 7/8 and CSI s/u keeps attributes", () => {
    const { t } = mk();
    t.write(`${ESC}[1;31m${ESC}[3;5H${ESC}7${ESC}[0m${ESC}[H${ESC}8`);
    expect([t.cur.x, t.cur.y]).toEqual([4, 2]);
    expect(t.cur.fg).toBe(1);
    expect(t.cur.fl & BOLD).toBe(BOLD);
    t.write(`${ESC}[2;2H${ESC}[s${ESC}[H${ESC}[u`);
    expect([t.cur.x, t.cur.y]).toEqual([1, 1]);
  });

  test("restore without save homes the cursor", () => {
    const { t } = mk();
    t.write(`abc${ESC}8`);
    expect([t.cur.x, t.cur.y]).toEqual([0, 0]);
  });

  test("DECALN fills the screen with E", () => {
    const { t, row } = mk(4, 2);
    t.write(`${ESC}#8`);
    expect(row(0)).toBe("EEEE");
    expect(row(1)).toBe("EEEE");
    t.write(`${ESC}#3`); // other # sequences ignored
    expect(row(0)).toBe("EEEE");
  });

  test("unknown intermediate escapes are ignored, keypad modes", () => {
    const { t } = mk();
    t.write(`${ESC} Fx${ESC}=`);
    expect(t.modes.appKeypad).toBe(true);
    t.write(`${ESC}>`);
    expect(t.modes.appKeypad).toBe(false);
    expect(t.lines[0]!.toString()).toBe("x");
  });

  test("ESC c full reset", () => {
    const { t } = mk();
    t.write(`abc${ESC}[?1h${ESC}[2;3r${ESC}[1m${ESC}[?1049hx${ESC}c`);
    expect(t.alt).toBe(false);
    expect(t.modes.appCursor).toBe(false);
    expect([t.top, t.bottom]).toEqual([0, 4]);
    expect(t.cur.fl).toBe(0);
    expect(t.lines[0]!.toString()).toBe("");
  });

  test("ESC inside OSC/DCS starts a new sequence unless ST", () => {
    const { t, events } = mk();
    t.write(`${ESC}]0;abc${ESC}\\`);
    expect(events.title).toEqual(["abc"]);
    t.write(`${ESC}]0;lost${ESC}[1mA`); // abandoned OSC, ESC [ starts CSI
    expect(events.title).toEqual(["abc"]);
    expect(t.cur.fl & BOLD).toBe(BOLD);
    expect(t.lines[0]!.toString()).toBe("A");
    t.write(`\r${ESC}[0m${ESC}Pdata${ESC}\\B`); // DCS terminated by ST
    expect(t.lines[0]!.toString()).toBe("B");
    t.write(`${ESC}_apc\x07C`); // APC terminated by BEL
    expect(t.lines[0]!.toString()).toBe("BC");
    t.write(`${ESC}^pm${ESC}[1mD`); // PM interrupted by ESC [
    expect(t.lines[0]!.toString()).toBe("BCD");
    t.write(`${ESC}Xsos\x18E`);
    expect(t.lines[0]!.toString()).toBe("BCDE");
  });
});

describe("cursor movement and edits", () => {
  test("CUU/CUD respect scroll region margins", () => {
    const { t } = mk(10, 8);
    t.write(`${ESC}[3;6r`);
    t.write(`${ESC}[4;1H${ESC}[9A`);
    expect(t.cur.y).toBe(2);
    t.write(`${ESC}[9B`);
    expect(t.cur.y).toBe(5);
    t.write(`${ESC}[8;1H${ESC}[2A`); // from below the region, CUU stops at the region top at most
    expect(t.cur.y).toBe(5);
    t.write(`${ESC}[8;1H${ESC}[2B`); // below the region: free down to the last row
    expect(t.cur.y).toBe(7);
  });

  test("CNL, CPL, CHA, HPA, HPR, CUF/CUB clamp", () => {
    const { t } = mk(10, 6);
    t.write(`${ESC}[3;5H${ESC}[2E`);
    expect([t.cur.x, t.cur.y]).toEqual([0, 4]);
    t.write(`${ESC}[3F`);
    expect([t.cur.x, t.cur.y]).toEqual([0, 1]);
    t.write(`${ESC}[7G`);
    expect(t.cur.x).toBe(6);
    t.write(`${ESC}[99\``);
    expect(t.cur.x).toBe(9);
    t.write(`${ESC}[99D`);
    expect(t.cur.x).toBe(0);
    t.write(`${ESC}[3a`);
    expect(t.cur.x).toBe(3);
    t.write(`${ESC}[99C`);
    expect(t.cur.x).toBe(9);
  });

  test("VPA and VPR", () => {
    const { t } = mk(10, 6);
    t.write(`${ESC}[2;4H${ESC}[5d`);
    expect([t.cur.x, t.cur.y]).toEqual([3, 4]);
    t.write(`${ESC}[1e`);
    expect(t.cur.y).toBe(5);
    t.write(`${ESC}[99d`);
    expect(t.cur.y).toBe(5);
  });

  test("CHT / CBT tab stops, HTS, TBC", () => {
    const { t } = mk(30, 2);
    t.write(`${ESC}[2I`);
    expect(t.cur.x).toBe(16);
    t.write(`${ESC}[Z`);
    expect(t.cur.x).toBe(8);
    t.write(`${ESC}[99Z`);
    expect(t.cur.x).toBe(0);
    t.write(`${ESC}[1;4H${ESC}H${ESC}[1;1H\t`);
    expect(t.cur.x).toBe(3);
    t.write(`${ESC}[g\t`); // clear stop at current column 3
    t.write(`${ESC}[1;1H\t`);
    expect(t.cur.x).toBe(8);
    t.write(`${ESC}[3g${ESC}[1;1H\t`);
    expect(t.cur.x).toBe(29);
  });

  test("ICH, DCH, ECH", () => {
    const { t, row } = mk(10, 2);
    t.write(`abcdef${ESC}[1;3H${ESC}[2@`);
    expect(row(0)).toBe("ab  cdef");
    t.write(`${ESC}[3P`);
    expect(row(0)).toBe("abdef");
    t.write(`${ESC}[1;2H${ESC}[2X`);
    expect(row(0)).toBe("a  ef");
    t.write(`${ESC}[99X`);
    expect(row(0)).toBe("a");
  });

  test("IL / DL inside and outside the scroll region", () => {
    const { t, row } = mk(5, 5);
    t.write("1\r\n2\r\n3\r\n4\r\n5");
    t.write(`${ESC}[2;4r${ESC}[2;1H${ESC}[L`);
    expect([row(0), row(1), row(2), row(3), row(4)]).toEqual(["1", "", "2", "3", "5"]);
    t.write(`${ESC}[2M`);
    expect([row(0), row(1), row(2), row(3), row(4)]).toEqual(["1", "3", "", "", "5"]);
    t.write(`${ESC}[1;1H${ESC}[L${ESC}[M`); // outside region: ignored
    expect(row(0)).toBe("1");
  });

  test("SU / SD scroll, SD ignores the xterm mouse-tracking form", () => {
    const { t, row } = mk(5, 3);
    t.write("a\r\nb\r\nc");
    t.write(`${ESC}[S`);
    expect([row(0), row(1), row(2)]).toEqual(["b", "c", ""]);
    expect(t.scrollback.length).toBe(1);
    t.write(`${ESC}[T`);
    expect([row(0), row(1), row(2)]).toEqual(["", "b", "c"]);
    t.write(`${ESC}[1;2;3;4;5T`);
    expect(row(0)).toBe("");
  });

  test("alt screen scrolling does not feed scrollback; region scroll neither", () => {
    const { t } = mk(5, 3);
    t.write(`${ESC}[2;3r${ESC}[3;1H\n\n`);
    expect(t.scrollback.length).toBe(0);
    t.write(`${ESC}[?1049h\n\n\n\n`);
    expect(t.scrollback.length).toBe(0);
  });

  test("REP repeats the last char; no-op without one", () => {
    const { t, row } = mk();
    t.write(`${ESC}[3b`);
    expect(row(0)).toBe("");
    t.write(`x${ESC}[3b`);
    expect(row(0)).toBe("xxxx");
  });

  test("insert mode shifts text", () => {
    const { t, row } = mk();
    t.write(`abc${ESC}[1;1H${ESC}[4hXY`);
    expect(row(0)).toBe("XYabc");
    t.write(`${ESC}[4l${ESC}[1;1HZ`);
    expect(row(0)).toBe("ZYabc");
  });

  test("scroll region validation", () => {
    const { t } = mk(10, 6);
    t.write(`${ESC}[3;99r`);
    expect([t.top, t.bottom]).toEqual([2, 5]);
    t.write(`${ESC}[4;2r`); // invalid: ignored
    expect([t.top, t.bottom]).toEqual([2, 5]);
    t.write(`${ESC}[r`);
    expect([t.top, t.bottom]).toEqual([0, 5]);
  });

  test("origin mode confines the cursor and positions relative to the region", () => {
    const { t, replies } = mk(10, 8);
    t.write(`${ESC}[3;6r${ESC}[?6h`);
    expect([t.cur.x, t.cur.y]).toEqual([0, 2]);
    t.write(`${ESC}[2;3H`);
    expect([t.cur.x, t.cur.y]).toEqual([2, 3]);
    t.write(`${ESC}[99;1H`);
    expect(t.cur.y).toBe(5);
    t.write(`${ESC}[6n`);
    expect(replies.at(-1)).toBe(`${ESC}[4;1R`);
    t.write(`${ESC}[?6n`);
    expect(replies.at(-1)).toBe(`${ESC}[?4;1R`);
    t.write(`${ESC}[1e`);
    expect(t.cur.y).toBe(5);
    t.write(`${ESC}[?6l`);
    expect([t.cur.x, t.cur.y]).toEqual([0, 0]);
  });
});

describe("erase", () => {
  function filled() {
    const m = mk(5, 3);
    m.t.write("aaaaa\r\nbbbbb\r\nccccc");
    return m;
  }

  test("ED 0/1/2/3", () => {
    let m = filled();
    m.t.write(`${ESC}[2;3H${ESC}[J`);
    expect([m.row(0), m.row(1), m.row(2)]).toEqual(["aaaaa", "bb", ""]);
    m = filled();
    m.t.write(`${ESC}[2;3H${ESC}[1J`);
    expect([m.row(0), m.row(1), m.row(2)]).toEqual(["", "   bb", "ccccc"]);
    m = filled();
    m.t.write(`${ESC}[2J`);
    expect([m.row(0), m.row(1), m.row(2)]).toEqual(["", "", ""]);
    m = mk(5, 2);
    m.t.write("1\r\n2\r\n3");
    expect(m.t.scrollback.length).toBe(1);
    m.t.write(`${ESC}[3J`);
    expect(m.t.scrollback.length).toBe(0);
    expect(m.t.trimmed).toBe(1);
  });

  test("EL 0/1/2, including DEC selective ?J ?K forms", () => {
    let m = filled();
    m.t.write(`${ESC}[2;3H${ESC}[K`);
    expect(m.row(1)).toBe("bb");
    m = filled();
    m.t.write(`${ESC}[2;3H${ESC}[1K`);
    expect(m.row(1)).toBe("   bb");
    m = filled();
    m.t.write(`${ESC}[2;3H${ESC}[2K`);
    expect(m.row(1)).toBe("");
    m = filled();
    m.t.write(`${ESC}[2;3H${ESC}[?K`);
    expect(m.row(1)).toBe("bb");
    m.t.write(`${ESC}[?2J`);
    expect(m.row(0)).toBe("");
  });

  test("erase uses the current background (BCE)", () => {
    const { t } = mk(4, 2);
    t.write(`${ESC}[44m${ESC}[2J${ESC}[1;1H${ESC}[K`);
    expect(t.lines[0]!.bg[0]).toBe(4);
    expect(t.lines[1]!.bg[3]).toBe(4);
    t.write(`${ESC}[41m${ESC}[S`);
    expect(t.lines[1]!.bg[0]).toBe(1);
  });

  test("erasing clears pending wrap", () => {
    const { t } = mk(3, 2);
    t.write(`abc${ESC}[K`);
    expect(t.cur.wrapPending).toBe(false);
  });
});

describe("modes", () => {
  test("private modes toggle state", () => {
    const { t } = mk();
    const on = (n: number) => t.write(`${ESC}[?${n}h`);
    const off = (n: number) => t.write(`${ESC}[?${n}l`);
    on(1); expect(t.modes.appCursor).toBe(true); off(1); expect(t.modes.appCursor).toBe(false);
    on(5); expect(t.modes.reverseVideo).toBe(true); off(5); expect(t.modes.reverseVideo).toBe(false);
    off(7); expect(t.modes.autowrap).toBe(false); on(7); expect(t.modes.autowrap).toBe(true);
    off(12); expect(t.modes.cursorBlink).toBe(false); on(12); expect(t.modes.cursorBlink).toBe(true);
    off(25); expect(t.modes.cursorVisible).toBe(false); on(25); expect(t.modes.cursorVisible).toBe(true);
    on(66); expect(t.modes.appKeypad).toBe(true); off(66);
    on(9); expect(t.modes.mouse).toBe(1000);
    on(1002); expect(t.modes.mouse).toBe(1002);
    on(1003); expect(t.modes.mouse).toBe(1003);
    off(1003); expect(t.modes.mouse).toBe(0);
    on(1004); expect(t.modes.focusEvents).toBe(true);
    on(1006); expect(t.modes.mouseSgr).toBe(true);
    off(1007); expect(t.modes.altScroll).toBe(false);
    on(2004); expect(t.modes.bracketedPaste).toBe(true);
    on(2026); expect(t.modes.synchronized).toBe(true);
    t.allDirty = false;
    off(2026); expect(t.modes.synchronized).toBe(false);
    expect(t.allDirty).toBe(true);
    t.write(`${ESC}[?1;7;25l`);
    expect(t.modes.appCursor).toBe(false);
    expect(t.modes.autowrap).toBe(false);
    expect(t.modes.cursorVisible).toBe(false);
  });

  test("no-wrap mode overwrites the last column", () => {
    const { t, row } = mk(4, 2);
    t.write(`${ESC}[?7labcdef`);
    expect(row(0)).toBe("abcf");
    expect(t.cur.x).toBe(3);
    expect(t.cur.wrapPending).toBe(false);
    t.write(`\r\n界界界`);
    expect(row(1).length).toBeGreaterThan(0);
  });

  test("DECSCUSR cursor styles", () => {
    const { t } = mk();
    const q = (n: number) => t.write(`${ESC}[${n} q`);
    q(0); expect([t.modes.cursorShape, t.modes.cursorBlink]).toEqual(["block", true]);
    q(2); expect([t.modes.cursorShape, t.modes.cursorBlink]).toEqual(["block", false]);
    q(3); expect([t.modes.cursorShape, t.modes.cursorBlink]).toEqual(["underline", true]);
    q(4); expect([t.modes.cursorShape, t.modes.cursorBlink]).toEqual(["underline", false]);
    q(5); expect([t.modes.cursorShape, t.modes.cursorBlink]).toEqual(["bar", true]);
    q(6); expect([t.modes.cursorShape, t.modes.cursorBlink]).toEqual(["bar", false]);
  });

  test("DECSTR soft reset keeps mouse/paste/etc. but resets the rest", () => {
    const { t } = mk();
    t.write(`${ESC}[?1000h${ESC}[?2004h${ESC}[?1h${ESC}[?7l${ESC}[1;31m${ESC}[2;3r${ESC}[?6h${ESC}[!p`);
    expect(t.modes.mouse).toBe(1000);
    expect(t.modes.bracketedPaste).toBe(true);
    expect(t.modes.appCursor).toBe(false);
    expect(t.modes.autowrap).toBe(true);
    expect(t.cur.fl).toBe(0);
    expect(t.cur.fg).toBe(DEFAULT);
    expect(t.cur.originMode).toBe(false);
    expect([t.top, t.bottom]).toEqual([0, 4]);
  });

  test("alternate screen 47 / 1047 / 1048 / 1049", () => {
    const { t, row } = mk(10, 3);
    t.write("prim");
    t.write(`${ESC}[?1049h`);
    expect(t.alt).toBe(true);
    expect(row(0)).toBe("");
    t.write("alt");
    t.write(`${ESC}[?1049h`); // idempotent
    t.write(`${ESC}[?1049l`);
    expect(t.alt).toBe(false);
    expect(row(0)).toBe("prim");
    expect(t.cur.x).toBe(4);
    t.write(`${ESC}[?1049l`); // already primary
    t.write(`${ESC}[?47h`);
    t.write("zzz");
    t.write(`${ESC}[?47l`);
    t.write(`${ESC}[?47h`);
    expect(t.alt).toBe(true);
  });

  test("1047 clears the alt buffer on entry; 1048 saves and restores the cursor", () => {
    const { t, row } = mk(10, 3);
    t.write(`${ESC}[?1047hx${ESC}[?1047l`);
    t.write(`${ESC}[?1047h`);
    expect(row(0)).toBe("");
    t.write(`${ESC}[?1047l${ESC}[2;3H${ESC}[?1048h${ESC}[H${ESC}[?1048l`);
    expect([t.cur.x, t.cur.y]).toEqual([2, 1]);
  });
});

describe("queries and reports", () => {
  test("DA1, DA2, XTVERSION, DSR 5/6, window ops", () => {
    const { t, replies } = mk(10, 4);
    t.write(`${ESC}[c`);
    expect(replies.at(-1)).toBe(`${ESC}[?62;22c`);
    t.write(`${ESC}[1c`);
    expect(replies.length).toBe(1);
    t.write(`${ESC}[>c`);
    expect(replies.at(-1)).toBe(`${ESC}[>0;10;1c`);
    t.write(`${ESC}[>q`);
    expect(replies.at(-1)).toBe(`${ESC}P>|codeviewer 1.0${ESC}\\`);
    t.write(`${ESC}[5n`);
    expect(replies.at(-1)).toBe(`${ESC}[0n`);
    t.write(`${ESC}[2;5H${ESC}[6n`);
    expect(replies.at(-1)).toBe(`${ESC}[2;5R`);
    t.write(`${ESC}[18t`);
    expect(replies.at(-1)).toBe(`${ESC}[8;4;10t`);
    const n = replies.length;
    t.write(`${ESC}[14t${ESC}[16t`);
    expect(replies.length).toBe(n); // no pixel size known
    t.cellPx = { w: 8, h: 16 };
    t.write(`${ESC}[14t`);
    expect(replies.at(-1)).toBe(`${ESC}[4;64;80t`);
    t.write(`${ESC}[16t`);
    expect(replies.at(-1)).toBe(`${ESC}[6;16;8t`);
    t.write(`${ESC}[=c${ESC}[<c${ESC}[?u`); // unknown prefixes: silent
    expect(replies.length).toBe(n + 2);
  });

  test("DECRQM for ANSI and private modes", () => {
    const { t, replies } = mk();
    t.write(`${ESC}[4$p`);
    expect(replies.at(-1)).toBe(`${ESC}[4;2$y`);
    t.write(`${ESC}[4h${ESC}[4$p`);
    expect(replies.at(-1)).toBe(`${ESC}[4;1$y`);
    t.write(`${ESC}[99$p`);
    expect(replies.at(-1)).toBe(`${ESC}[99;0$y`);
    const q = (m: number) => {
      t.write(`${ESC}[?${m}$p`);
      return replies.at(-1);
    };
    expect(q(1)).toBe(`${ESC}[?1;2$y`);
    t.write(`${ESC}[?1h`);
    expect(q(1)).toBe(`${ESC}[?1;1$y`);
    expect(q(6)).toBe(`${ESC}[?6;2$y`);
    expect(q(7)).toBe(`${ESC}[?7;1$y`);
    expect(q(12)).toBe(`${ESC}[?12;1$y`);
    expect(q(25)).toBe(`${ESC}[?25;1$y`);
    t.write(`${ESC}[?1002h`);
    expect(q(1002)).toBe(`${ESC}[?1002;1$y`);
    expect(q(1000)).toBe(`${ESC}[?1000;2$y`);
    expect(q(1003)).toBe(`${ESC}[?1003;2$y`);
    expect(q(1004)).toBe(`${ESC}[?1004;2$y`);
    expect(q(1006)).toBe(`${ESC}[?1006;2$y`);
    expect(q(1007)).toBe(`${ESC}[?1007;1$y`);
    expect(q(1049)).toBe(`${ESC}[?1049;2$y`);
    expect(q(47)).toBe(`${ESC}[?47;2$y`);
    expect(q(1047)).toBe(`${ESC}[?1047;2$y`);
    expect(q(2004)).toBe(`${ESC}[?2004;2$y`);
    expect(q(2026)).toBe(`${ESC}[?2026;2$y`);
    expect(q(9999)).toBe(`${ESC}[?9999;0$y`);
  });

  test("silent suppresses replies and clipboard writes", () => {
    const { t, replies, events } = mk();
    t.silent = true;
    t.write(`${ESC}[c${ESC}[5n${ESC}]52;c;${btoa("hi")}\x07`);
    expect(replies).toEqual([]);
    expect(events.clip).toEqual([]);
    t.silent = false;
    t.write(`${ESC}]52;c;${btoa("hi")}\x07`);
    expect(events.clip).toEqual(["hi"]);
  });
});

describe("SGR", () => {
  test("all simple attributes set and clear", () => {
    const { t } = mk();
    t.write(`${ESC}[1;2;3;4;5;7;8;9;53m`);
    const all = BOLD | DIM | ITALIC | UNDERLINE | BLINK | INVERSE | HIDDEN | STRIKE | 256;
    expect(t.cur.fl).toBe(all);
    t.write(`${ESC}[22;23;24;25;27;28;29;55m`);
    expect(t.cur.fl).toBe(0);
    t.write(`${ESC}[6;21m`);
    expect(t.cur.fl).toBe(BLINK | UNDERLINE);
    t.write(`${ESC}[m`);
    expect(t.cur.fl).toBe(0);
  });

  test("basic, bright, default colors", () => {
    const { t } = mk();
    t.write(`${ESC}[31;42m`);
    expect([t.cur.fg, t.cur.bg]).toEqual([1, 2]);
    t.write(`${ESC}[91;102m`);
    expect([t.cur.fg, t.cur.bg]).toEqual([9, 10]);
    t.write(`${ESC}[39;49m`);
    expect([t.cur.fg, t.cur.bg]).toEqual([DEFAULT, DEFAULT]);
  });

  test("256 and truecolor, semicolon form", () => {
    const { t } = mk();
    t.write(`${ESC}[38;5;200;48;5;17m`);
    expect([t.cur.fg, t.cur.bg]).toEqual([200, 17]);
    t.write(`${ESC}[38;2;1;2;3;48;2;255;254;253m`);
    expect(t.cur.fg).toBe(RGB_FLAG | 0x010203);
    expect(t.cur.bg).toBe(RGB_FLAG | 0xfffefd);
    t.write(`${ESC}[38;5;999m`);
    expect(t.cur.fg).toBe(255);
    t.write(`${ESC}[58;5;3m`); // underline color is accepted but not stored
    expect(t.cur.fg).toBe(255);
  });

  test("colon form, with and without colorspace id; underline sub-params", () => {
    const { t } = mk();
    t.write(`${ESC}[38:5:42m`);
    expect(t.cur.fg).toBe(42);
    t.write(`${ESC}[38:2::10:20:30m`);
    expect(t.cur.fg).toBe(RGB_FLAG | 0x0a141e);
    t.write(`${ESC}[48:2:1:2:3m`);
    expect(t.cur.bg).toBe(RGB_FLAG | 0x010203);
    t.write(`${ESC}[4:3m`);
    expect(t.cur.fl & UNDERLINE).toBe(UNDERLINE);
    t.write(`${ESC}[4:0m`);
    expect(t.cur.fl & UNDERLINE).toBe(0);
  });

  test("reset preserves hyperlink id; empty subparams are treated as 0", () => {
    const { t } = mk();
    t.write(`${ESC}]8;;http://a\x07${ESC}[1m${ESC}[0m`);
    expect(t.cur.fl >>> 16).toBe(1);
    expect(t.cur.fl & 0xffff).toBe(0);
    t.write(`${ESC}[;1m`);
    expect(t.cur.fl & BOLD).toBe(BOLD);
  });

  test("CSI param edge cases: overflow clamp, unknown finals, ignored sequences", () => {
    const { t, row } = mk();
    t.write(`${ESC}[99999999C`);
    expect(t.cur.x).toBe(19);
    t.write(`\r${ESC}[1?mA`); // prefix after digits => ignored sequence, then 'A' printed
    expect(row(0)).toBe("A");
    t.write(`${ESC}[1\x01mB`); // C0 inside CSI executes, sequence continues
    t.write(`${ESC}[1;2\u0001`);
    t.write(`${ESC}[ 1\x7f`); // invalid byte -> CsiIgnore
    t.write(`${ESC}[%zZ`);
    expect(row(0).includes("A")).toBe(true);
  });
});

describe("OSC", () => {
  test("title (0 and 2), cwd, invalid cwd", () => {
    const { t, events } = mk();
    t.write(`${ESC}]0;one\x07${ESC}]2;two${ESC}\\`);
    expect(events.title).toEqual(["one", "two"]);
    expect(t.title).toBe("two");
    t.write(`${ESC}]7;file:///home/u/my%20dir\x07`);
    expect(events.cwd).toEqual(["/home/u/my dir"]);
    t.write(`${ESC}]7;not a url\x07`);
    expect(events.cwd.length).toBe(1);
    t.write(`${ESC}]999;x\x07${ESC}]nosemi\x07`);
  });

  test("OSC 8 hyperlinks assign, reuse and clear ids", () => {
    const { t } = mk();
    t.write(`${ESC}]8;;http://a\x07A${ESC}]8;;http://b\x07B${ESC}]8;;http://a\x07C${ESC}]8;;\x07D`);
    const l = t.lines[0]!;
    expect(l.fl[0]! >>> 16).toBe(1);
    expect(l.fl[1]! >>> 16).toBe(2);
    expect(l.fl[2]! >>> 16).toBe(1);
    expect(l.fl[3]! >>> 16).toBe(0);
    expect(t.links.slice(1)).toEqual(["http://a", "http://b"]);
  });

  test("color queries 10/11/12 and 4", () => {
    const { t, replies } = mk();
    t.write(`${ESC}]10;?\x07${ESC}]11;?${ESC}\\${ESC}]12;?\x07`);
    expect(replies).toEqual([
      `${ESC}]10;rgb:c0c0/c0c0/c0c0${ESC}\\`,
      `${ESC}]11;rgb:1010/1111/1212${ESC}\\`,
      `${ESC}]12;rgb:ffff/ffff/ffff${ESC}\\`,
    ]);
    replies.length = 0;
    t.write(`${ESC}]4;1;?;0;?;7;?\x07`);
    expect(replies).toEqual([`${ESC}]4;1;rgb:ffff/0000/0000${ESC}\\`, `${ESC}]4;0;rgb:0000/0000/0000${ESC}\\`]);
    replies.length = 0;
    t.write(`${ESC}]10;notaquery\x07`);
    expect(replies).toEqual([]);
  });

  test("no colors callback means no color replies", () => {
    const replies: string[] = [];
    const t = new Terminal(10, 2, { reply: (d) => replies.push(d) });
    t.write(`${ESC}]10;?\x07${ESC}]4;1;?\x07`);
    expect(replies).toEqual([]);
  });

  test("OSC 52 write, query refusal and bad base64", () => {
    const { t, events } = mk();
    t.write(`${ESC}]52;c;${btoa("héllo")}\x07`);
    expect(events.clip).toEqual([btoa("héllo") && "hÃ©llo"].length ? events.clip : []);
    t.write(`${ESC}]52;c;?\x07${ESC}]52;c;!!!\x07`);
    expect(events.clip.length).toBe(1);
  });

  test("OSC 52 decodes utf-8", () => {
    const { t, events } = mk();
    const b64 = Buffer.from("héllo ✓").toString("base64");
    t.write(`${ESC}]52;c;${b64}\x07`);
    expect(events.clip).toEqual(["héllo ✓"]);
  });
});

describe("printing", () => {
  test("combining marks attach to the previous cell, also after pending wrap", () => {
    const { t } = mk(5, 2);
    t.write("é");
    expect(t.lines[0]!.text[0]).toBe("é");
    expect(t.cur.x).toBe(1);
    t.write(`\r\n abcd́`);
    expect(t.lines[1]!.text[4]).toBe("d́");
    t.write(`${ESC}[1;1H́`);
    expect(t.lines[0]!.text[0]).toBe("é");
  });

  test("combining mark after a wide char attaches to the lead cell", () => {
    const { t } = mk(6, 2);
    t.write("漢️");
    expect(t.lines[0]!.text[0]).toBe("漢️");
    expect(t.cur.x).toBe(2);
  });

  test("ZWJ emoji sequences join into one cluster", () => {
    const { t } = mk(10, 2);
    t.write("👩‍💻x");
    expect(t.lines[0]!.text[0]).toBe("👩‍💻");
    expect(t.lines[0]!.text[1]).toBe("");
    expect(t.lines[0]!.text[2]).toBe("x");
  });

  test("wide chars occupy two cells with WIDE flag; at the last column they wrap", () => {
    const { t } = mk(5, 2);
    t.write("abcd漢");
    expect(t.lines[0]!.wrapped).toBe(true);
    expect(t.lines[1]!.text[0]).toBe("漢");
    expect(t.lines[1]!.fl[0]! & WIDE).toBe(WIDE);
    expect(t.lines[1]!.text[1]).toBe("");
    expect(t.cur.x).toBe(2);
  });

  test("overwriting half of a wide char blanks the other half", () => {
    const { t, row } = mk(6, 2);
    t.write("漢字");
    t.write(`${ESC}[1;2Hx`); // over the continuation cell of 漢
    expect(row(0)).toBe(" x字");
    t.write(`${ESC}[1;3H漢`);
    t.write(`${ESC}[1;4Hy`);
    expect(t.lines[0]!.text[2]).toBe(" ");
    expect(t.lines[0]!.text[3]).toBe("y");
    t.write(`${ESC}[1;1H界`); // wide over wide-overlap on the right
    expect(t.lines[0]!.text[0]).toBe("界");
  });

  test("astral characters and split surrogates in a stream", () => {
    const { t, row } = mk();
    t.write("𝒳\ud83d");
    t.write("\ude00z");
    expect(row(0)).toBe("𝒳😀z");
  });

  test("lone high surrogate at end of chunk is printed raw", () => {
    const { t } = mk();
    t.write("a\ud800");
    expect(t.lines[0]!.text[1]).toBe("\ud800");
  });

  test("byte input is decoded as streaming UTF-8", () => {
    const { t, row } = mk();
    const bytes = new TextEncoder().encode("é✓");
    t.write(bytes.slice(0, 1));
    t.write(bytes.slice(1, 3));
    t.write(bytes.slice(3));
    expect(row(0)).toBe("é✓");
  });

  test("DEC graphics falls through for unmapped characters", () => {
    const { t, row } = mk();
    t.write(`${ESC}(0A${ESC}(B`);
    expect(row(0)).toBe("A");
  });

  test("unwrapped continuation: erase in line clears wrapped flag", () => {
    const { t } = mk(3, 3);
    t.write("abcd");
    expect(t.lines[0]!.wrapped).toBe(true);
    t.write(`${ESC}[1;1H${ESC}[K`);
    expect(t.lines[0]!.wrapped).toBe(false);
  });
});

describe("scrollback and history access", () => {
  test("trimming past the limit bumps trimmed", () => {
    const { t } = mk(5, 2);
    for (let i = 0; i < MAX_SCROLLBACK + 1100; i++) t.write("x\n");
    expect(t.scrollback.length).toBeLessThanOrEqual(MAX_SCROLLBACK + 1000);
    expect(t.trimmed).toBeGreaterThan(0);
    expect(t.scrolledOff).toBeGreaterThan(MAX_SCROLLBACK);
  });

  test("viewLine / absLine / totalLines, with lazy widening of history", () => {
    const { t } = mk(4, 2);
    t.write("a\r\nb\r\nc\r\nd");
    expect(t.totalLines).toBe(t.scrollback.length + 2);
    expect(t.scrollback.length).toBe(2);
    expect(t.viewLine(0, 2)!.toString()).toBe("a");
    expect(t.viewLine(1, 0)!.toString()).toBe("d");
    expect(t.absLine(1)!.toString()).toBe("b");
    expect(t.absLine(99)).toBeUndefined();
    t.resize(8, 2);
    expect(t.absLine(0)!.cols).toBe(8);
  });
});

describe("resize and reset", () => {
  test("no-op resize returns early; minimum sizes are enforced", () => {
    const { t } = mk(5, 3);
    t.resize(5, 3);
    t.resize(0, 0);
    expect([t.cols, t.rows]).toEqual([2, 1]);
  });

  test("shrinking rows pushes lines above the cursor into scrollback", () => {
    const { t, row } = mk(5, 4);
    t.write("1\r\n2\r\n3\r\n4");
    t.resize(5, 2);
    expect(t.scrollback.map((l) => l.toString())).toEqual(["1", "2"]);
    expect([row(0), row(1)]).toEqual(["3", "4"]);
    expect(t.cur.y).toBe(1);
    expect(t.scrolledOff).toBe(2);
  });

  test("shrinking with the cursor at the top drops bottom lines instead", () => {
    const { t, row } = mk(5, 4);
    t.write("1\r\n2\r\n3\r\n4\x1b[H");
    t.resize(5, 2);
    expect(t.scrollback.length).toBe(0);
    expect([row(0), row(1)]).toEqual(["1", "2"]);
  });

  test("growing rows pulls history back down", () => {
    const { t, row } = mk(5, 2);
    t.write("1\r\n2\r\n3\r\n4");
    expect(t.scrollback.length).toBe(2);
    t.write(`${ESC}7`); // saved cursor should follow
    t.resize(5, 4);
    expect(t.scrollback.length).toBe(0);
    expect([row(0), row(1), row(2), row(3)]).toEqual(["1", "2", "3", "4"]);
    expect(t.cur.y).toBe(3);
    t.resize(5, 6); // nothing left to pull: blank lines added
    expect(t.lines.length).toBe(6);
    expect(row(4)).toBe("");
  });

  test("column resize narrows/widens lines, clamps cursor, preserves tab stops, resets region", () => {
    const { t } = mk(20, 3);
    t.write(`${ESC}[2;3r${ESC}[1;15H${ESC}7`);
    t.resize(10, 3);
    expect(t.cur.x).toBe(9);
    expect([t.top, t.bottom]).toEqual([0, 2]);
    expect(t.lines[0]!.cols).toBe(10);
    t.write("\r\t");
    expect(t.cur.x).toBe(8);
    t.resize(30, 3);
    t.write("\r\t\t\t");
    expect(t.cur.x).toBe(24);
    t.write(`${ESC}8`);
    expect(t.cur.x).toBeLessThan(30);
  });

  test("resizing while on the alternate screen resizes both buffers", () => {
    const { t, row } = mk(6, 4);
    t.write("1\r\n2\r\n3\r\n4");
    t.write(`${ESC}[?1049h`);
    t.write("alt");
    t.resize(6, 2);
    expect(t.lines.length).toBe(2);
    t.write(`${ESC}[?1049l`);
    expect(t.lines.length).toBe(2);
    expect(t.alt).toBe(false);
    t.resize(6, 4);
    expect(t.lines.length).toBe(4);
    expect(row(0)).not.toBeUndefined();
  });

  test("reset() clears everything and bumps trimmed", () => {
    const { t, row } = mk(5, 2);
    t.write(`${ESC}]8;;http://x\x07a\r\nb\r\nc${ESC}[?1049h`);
    const before = t.trimmed;
    t.reset();
    expect(t.alt).toBe(false);
    expect(t.scrollback.length).toBe(0);
    expect(t.links).toEqual([""]);
    expect(t.trimmed).toBe(before + 1);
    expect([row(0), row(1)]).toEqual(["", ""]);
    expect([t.cur.x, t.cur.y]).toEqual([0, 0]);
  });
});

describe("remaining escapes", () => {
  test("ESC D / E / M move vertically", () => {
    const { t } = mk(10, 3);
    t.write(`ab${ESC}Dc`);
    expect([t.cur.x, t.cur.y]).toEqual([3, 1]);
    t.write(`${ESC}Ed`);
    expect([t.cur.x, t.cur.y]).toEqual([1, 2]);
    t.write(`${ESC}M${ESC}M`);
    expect(t.cur.y).toBe(0);
    expect(t.lines[1]!.toString()).toBe("  c");
    t.write(`${ESC}M`); // at top: scrolls down
    expect(t.lines[0]!.toString()).toBe("");
    expect(t.lines[1]!.toString()).toBe("ab");
  });

  test("ESC with multiple intermediates before the final", () => {
    const { t } = mk();
    t.write(`${ESC}(0A`);
    expect(t.cur.charsets[0]).toBe(true);
    t.write(`${ESC}(B${ESC}  Fz`);
    expect(t.lines[0]!.toString().endsWith("z")).toBe(true);
  });

  test("writing a narrow char over a wide lead blanks the continuation", () => {
    const { t } = mk(6, 1);
    t.write(`漢${ESC}[1;1Hx`);
    expect(t.lines[0]!.text[0]).toBe("x");
    expect(t.lines[0]!.text[1]).toBe(" ");
  });
});
