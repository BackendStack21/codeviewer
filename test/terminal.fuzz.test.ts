import { expect, test } from "bun:test";
import { Terminal } from "../src/client/term/terminal.ts";

// Hostile program output (`cat evil.txt`) must never throw, leave the screen model inconsistent,
// grow without bound, or make the terminal answer the program with attacker text (an answer is
// typed into the shell's input). Seeded and deterministic; resizes and split writes included.

const MARK = "PWN";
const PIECES = [
  // controls and sequence starters
  "\x1b", "\x1b[", "\x1b]", "\x1bP", "\x1b_", "\x1b^", "\x1bX", "\u009b", "\u009d", "\u0090", "\u009c", "\x07", "\x18", "\x1a", "\x1b\\",
  "\r", "\n", "\t", "\b", "\x0b", "\x0c", "\x0e", "\x0f", "\x1bc", "\x1b7", "\x1b8", "\x1bM", "\x1bD", "\x1bE", "\x1b#8", "\x1b(0", "\x1b(B",
  // CSI parameters, finals and prefixes, with huge and odd values
  "?", ">", "=", "<", "$", "!", " ", "\"", "'", ";", ":", "0", "1", "25", "47", "1049", "2004", "1000", "1006", "65535", "99999999", "-1",
  "A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "P", "S", "T", "X", "@", "b", "c", "d", "f", "g", "h", "l", "m", "n", "p",
  "q", "r", "s", "t", "u", "x", "y", "z", "{", "|", "}", "~", "$p", "$y", "!p", "*x", " q",
  // payloads that must never come back: titles, DECRQSS, XTGETTCAP, OSC queries with junk
  `0;${MARK}`, `2;${MARK}\x07`, `$q${MARK}`, `+q${MARK}`, `4;1;?;${MARK}`, `10;?`, `11;?${MARK}`, `52;c;${btoa(MARK)}`, `8;;https://${MARK}.example/`,
  `7;file://${MARK}/`, `${MARK}`,
  // text: wide, combining, ZWJ, emoji, surrogate halves, Latin-1
  "x", "é", "日本", "́", "‍", "👩‍💻", "🇺🇸", "\ud83d", "\ude00", " ", "Ω",
];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32;
}

function checkInvariants(t: Terminal, where: string) {
  const bad = (what: string) => {
    throw new Error(`${where}: ${what}`);
  };
  if (t.lines.length !== t.rows) bad(`lines ${t.lines.length} != rows ${t.rows}`);
  if (t.cur.x < 0 || t.cur.x >= t.cols) bad(`cursor x ${t.cur.x} of ${t.cols}`);
  if (t.cur.y < 0 || t.cur.y >= t.rows) bad(`cursor y ${t.cur.y} of ${t.rows}`);
  for (const l of t.lines) {
    if (l.text.length !== t.cols) bad(`a line has ${l.text.length} cells for ${t.cols} columns`);
    for (const c of l.text) if (c.length > 64) bad(`a cell holds ${c.length} code units`);
  }
  if (t.links.length > 0x10000) bad(`${t.links.length} links`);
}

test("2000 seeded hostile streams: no throw, consistent screen, bounded cells, no echoed payload", () => {
  const enc = new TextEncoder();
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed);
    const replies: string[] = [];
    const t = new Terminal(2 + Math.floor(r() * 120), 1 + Math.floor(r() * 40), {
      reply: (d) => replies.push(d),
      colors: () => ({ fg: "#ffffff", bg: "#000000", cursor: "#ffffff", palette: Array(256).fill("#123456") }),
      title: () => {},
      clipboard: () => {},
    });
    let text = "";
    const n = 20 + Math.floor(r() * 200);
    for (let i = 0; i < n; i++) text += PIECES[Math.floor(r() * PIECES.length)];
    const bytes = enc.encode(text);
    try {
      for (let at = 0; at < bytes.length; ) {
        const len = 1 + Math.floor(r() * 16);
        t.write(bytes.subarray(at, at + len));
        at += len;
        if (r() < 0.02) t.resize(2 + Math.floor(r() * 120), 1 + Math.floor(r() * 40));
      }
      // Strings work too (the page writes both).
      t.write(text.slice(0, 200));
    } catch (e) {
      throw new Error(`seed ${seed} threw ${(e as Error).message}: ${JSON.stringify(text.slice(0, 300))}`);
    }
    checkInvariants(t, `seed ${seed}`);
    for (const rep of replies) {
      if (rep.includes(MARK)) throw new Error(`seed ${seed}: a reply echoed attacker text: ${JSON.stringify(rep)}`);
      if (rep.length > 4096) throw new Error(`seed ${seed}: a ${rep.length}-character reply`);
      // A reply that contains a line break would submit whatever precedes it at the prompt.
      if (/[\r\n]/.test(rep)) throw new Error(`seed ${seed}: a reply with a line break: ${JSON.stringify(rep)}`);
    }
  }
});

test("replayed history (silent) never answers, writes the clipboard or rings", () => {
  let replies = 0;
  let clips = 0;
  let bells = 0;
  const t = new Terminal(80, 24, { reply: () => replies++, clipboard: () => clips++, bell: () => bells++, colors: () => ({ fg: "#fff", bg: "#000", cursor: "#fff", palette: [] }) });
  t.silent = true;
  t.write(`\x1b[6n\x1b[c\x1b[>c\x1b]11;?\x07\x1b]52;c;${btoa("x")}\x07\x07\x1b[?2004$p`);
  expect({ replies, clips, bells }).toEqual({ replies: 0, clips: 0, bells: 0 });
});
