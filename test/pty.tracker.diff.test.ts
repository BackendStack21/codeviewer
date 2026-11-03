import { expect, test } from "bun:test";
import { ModeTracker, modesPrefix } from "../src/server/pty.ts";
import { Terminal } from "../src/client/term/terminal.ts";

// The server rebuilds input-affecting modes on reload from its own tracker (pty.ts). If it ever
// disagrees with the terminal in the page, a reload turns bracketed paste off (a paste then runs
// line by line) or mouse reporting on (clicks type into the shell). Differential fuzz: the same
// random output, split at random points, goes to the real client parser and to the tracker; a
// fresh terminal given the tracker's prefix must end up in the same modes as the live one.

const PIECES = [
  "\x1b", "[", "?", "\u009b", "\u009d", "\u0090", "\u009c", "\u0098", "\x07", "\x18", "\x1a", "\x1b\\", "\x1b]0;t", "\x1bP", "\x1b_", "\x1b^",
  "1049", "1047", "47", "1000", "1002", "1003", "9", "1006", "1004", "2004", "25", "1", "7", "1048",
  ";", ":", "h", "l", "h", "l", "!p", "\x1bc", "\x1b(0", "\x1b#8", ">", "=", "$", " ", "\n", "\r", "x", "é", "\x1b[", "\x1b[?",
];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32;
}

const view = (t: Terminal) => ({
  paste: t.modes.bracketedPaste,
  mouse: t.modes.mouse,
  sgr: t.modes.mouseSgr,
  focus: t.modes.focusEvents,
  appCursor: t.modes.appCursor,
  cursor: t.modes.cursorVisible,
  alt: t.alt,
});

test("the replay prefix restores exactly the modes the live terminal is in (2000 seeded streams)", () => {
  const enc = new TextEncoder();
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed);
    let text = "";
    const n = 5 + Math.floor(r() * 60);
    for (let i = 0; i < n; i++) text += PIECES[Math.floor(r() * PIECES.length)];
    const bytes = enc.encode(text);
    const live = new Terminal(80, 24, { reply: () => {} });
    const tracker = new ModeTracker();
    // Split at random byte positions (inside UTF-8 sequences too), as PTY reads do.
    for (let at = 0; at < bytes.length; ) {
      const len = 1 + Math.floor(r() * 7);
      const chunk = bytes.subarray(at, at + len);
      live.write(chunk);
      tracker.write(chunk);
      at += len;
    }
    const replay = new Terminal(80, 24, { reply: () => {} });
    replay.write(modesPrefix(tracker.modes));
    if (JSON.stringify(view(replay)) !== JSON.stringify(view(live))) {
      throw new Error(`seed ${seed}: ${JSON.stringify(text)}\nlive   ${JSON.stringify(view(live))}\nreplay ${JSON.stringify(view(replay))}`);
    }
  }
});

test("the reported attack: a C1 CSI after ESC or inside a string does not switch bracketed paste off", () => {
  for (const evil of ["\x1b\u009b?2004l", "\x1b]0;\u009b?2004l\x07", "\x1bP\u009b?2004l\x1b\\", "\x1b_\u009b?2004l\x1b\\"]) {
    const t = new ModeTracker();
    t.text("\x1b[?2004h" + evil);
    expect([evil, t.modes.get(2004)]).toEqual([evil, true]);
  }
  // While a real C1 CSI in the ground state is honoured, as by the client.
  const t = new ModeTracker();
  t.text("\x1b[?2004h\u009b?2004l");
  expect(t.modes.get(2004)).toBe(false);
});
