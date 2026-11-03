import { expect, test } from "bun:test";
import { Terminal } from "../src/client/term/terminal.ts";

// Hostile program output (`cat evil.txt`) must not grow memory or CPU without bound.
const maxCell = (t: Terminal) => Math.max(...t.lines.flatMap((l) => l.text.map((x) => x.length)));

test("a cell's cluster is capped: combining marks and ZWJ + REP cannot grow it without bound", () => {
  const t = new Terminal(80, 24, { reply: () => {} });
  t.write("a" + "́".repeat(100_000));
  expect(maxCell(t)).toBeLessThanOrEqual(64);
  const u = new Terminal(80, 24, { reply: () => {} });
  u.write("a‍" + "\x1b[65535b".repeat(100)); // was a 13M-char cell after 800 bytes
  expect(maxCell(u)).toBeLessThanOrEqual(64);
  // REP repeats the base character.
  const v = new Terminal(10, 2, { reply: () => {} });
  v.write("é\x1b[3b");
  expect(v.lines[0]!.text.slice(0, 4)).toEqual(["é", "e", "e", "e"]);
  // Real emoji ZWJ sequences still join into one cell.
  const w = new Terminal(10, 2, { reply: () => {} });
  w.write("👩‍💻x");
  expect(w.lines[0]!.text[0]).toBe("👩‍💻");
});

test("REP repeats at most a screenful (8 KB of REP used to scroll for seconds)", () => {
  const t = new Terminal(80, 24, { reply: () => {}, onLine: () => {} });
  const t0 = performance.now();
  t.write("x" + "\x1b[65535b".repeat(1000));
  expect(performance.now() - t0).toBeLessThan(2000);
});

test("OSC 8: lookups are constant time, long targets are not links, ids are never reused", () => {
  const t = new Terminal(80, 24, { reply: () => {} });
  t.write("\x1b]8;;README.md\x07R\x1b]8;;\x07");
  const id = t.lines[0]!.fl[0]! >>> 16;
  expect(t.links[id]).toBe("README.md");
  let s = "";
  for (let i = 0; i < 70_000; i++) s += `\x1b]8;;https://e.example/${i}\x07y`;
  const t0 = performance.now();
  t.write(s);
  expect(performance.now() - t0).toBeLessThan(3000);
  // The table is full: the old link still names its own target.
  expect(t.links[id]).toBe("README.md");
  const u = new Terminal(80, 24, { reply: () => {} });
  u.write(`\x1b]8;;https://x.example/${"a".repeat(5000)}\x07L`);
  expect(u.lines[0]!.fl[0]! >>> 16).toBe(0);
});

test("OSC 4 answers at most 256 queries per sequence", () => {
  let n = 0;
  const t = new Terminal(80, 24, {
    reply: () => n++,
    colors: () => ({ fg: "#ffffff", bg: "#000000", cursor: "#ffffff", palette: Array(256).fill("#123456") }),
  });
  t.write("\x1b]4" + ";1;?".repeat(10_000) + "\x07");
  expect(n).toBe(256);
});
