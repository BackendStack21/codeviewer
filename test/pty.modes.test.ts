import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModeTracker, modesPrefix, PtyManager, type PtySocketData } from "../src/server/pty.ts";

test("ModeTracker: C1 CSI (UTF-8), colon sub-parameters and the alt-screen group", () => {
  const t = new ModeTracker();
  t.write(new TextEncoder().encode("\u009b?1049h\u009b?1000h"));
  expect(t.modes.get(1049)).toBe(true);
  expect(t.modes.get(1000)).toBe(true);
  t.text("\x1b[?2004:1h\x1b[?47h");
  expect(t.modes.get(2004)).toBe(true);
  expect(t.modes.has(1049)).toBe(false); // one alt-screen mode at a time
  // A bare 0x9B byte is a UTF-8 continuation byte (ě is C4 9B), never CSI.
  const n = new ModeTracker();
  n.write(new TextEncoder().encode("ě?1000h"));
  expect(n.modes.size).toBe(0);
  n.text("\x1b[?25l");
  expect(modesPrefix(n.modes)).toBe("\x1b[?25l"); // a hidden cursor is restored too
});

let dir = "";
let m: PtyManager | null = null;
afterEach(async () => {
  m?.killAll();
  m = null;
  if (dir) await rm(dir, { recursive: true, force: true });
});

function fakeWs(id: string) {
  return {
    data: { kind: "pty", id, cols: 80, rows: 24 } as PtySocketData,
    texts: [] as string[],
    bins: [] as Uint8Array[],
    send(s: string) { this.texts.push(s); },
    sendBinary(b: Uint8Array) { this.bins.push(b); },
    close() {},
    getBufferedAmount() { return 0; },
    output() { return new TextDecoder().decode(Buffer.concat(this.bins)); },
  };
}
const asWs = (w: ReturnType<typeof fakeWs>) => w as unknown as Parameters<PtyManager["open"]>[0];

async function until(cond: () => boolean, ms = 10000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(20);
  }
}

test("a mode sequence longer than the old 24-byte carry, split across reads, is tracked", async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-ptymodes-")));
  m = new PtyManager({ shell: "/bin/sh", cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PS1: "$ " } });
  const a = fakeWs("modes-split");
  m.open(asWs(a));
  m.message(asWs(a), Buffer.from("printf '\\033[?1000;1002;1003;1004;10'; sleep 0.3; printf '06;2004h'; echo; echo MARK\n"));
  // "\r\nMARK": the program's output, not the echo of the typed command line.
  await until(() => a.output().includes("\r\nMARK\r\n"));
  m.close(asWs(a));
  type S = { modes: Map<number, boolean>; trackModes(d: Uint8Array): void };
  const s = (m as unknown as { sessions: Map<string, S> }).sessions.get("modes-split")!;
  expect(s.modes.get(2004)).toBe(true);
  expect(s.modes.get(1006)).toBe(true);
  // Deterministically split, 27 bytes before the cut (the old carry kept 24).
  s.modes.clear();
  s.trackModes(new TextEncoder().encode("x\x1b[?1000;1002;1003;1004;10"));
  s.trackModes(new TextEncoder().encode("06;2004h"));
  expect(s.modes.get(2004)).toBe(true);
  expect(s.modes.get(1003)).toBe(true);
});

test("a trimmed replay includes mode changes in the bytes it skips (a TUI that exited)", async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-ptymodes-")));
  m = new PtyManager({ shell: "/bin/sh", cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PS1: "$ " } });
  const a = fakeWs("modes-trim");
  m.open(asWs(a));
  m.close(asWs(a));
  const s = (m as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions.get("modes-trim")!;
  // The ring's first chunk: it starts inside an old line, then the TUI leaves alt screen, mouse and paste.
  const before = new ModeTracker();
  before.text("\x1b[?1049h\x1b[?1000h\x1b[?2004h");
  s.chunks = [{ data: new TextEncoder().encode("partial\x1b[?2004l\x1b[?1000l\x1b[?1049lEXITED\n$ prompt"), state: before.state() }];
  s.ringTrimmed = true;
  const b = fakeWs("x");
  (s.sendReplay as (ws: unknown) => void).call(s, b);
  const out = b.output();
  expect(out.startsWith("$ prompt")).toBe(true); // no stale mode prefix in front of the prompt
  expect(out).not.toContain("\x1b[?1049h");
});

test("a shell that cannot start ends that terminal, not the server", async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-ptymodes-")));
  m = new PtyManager({ shell: "/bin/sh", cwd: path.join(dir, "deleted"), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const a = fakeWs("no-shell");
  let closed: unknown[] | null = null;
  (a as unknown as { close: (...x: unknown[]) => void }).close = (...x: unknown[]) => (closed = x);
  expect(() => m!.open(asWs(a))).not.toThrow();
  expect(a.texts).toEqual([JSON.stringify({ t: "exit", code: -1 })]);
  expect(closed).toEqual([1011, "could not start a shell"]);
});
