import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PtyManager, type PtySocketData } from "../src/server/pty.ts";

/** A minimal fake ServerWebSocket recording everything the session sends. */
function fakeWs(id: string, cols = 80, rows = 24) {
  const ws = {
    data: { kind: "pty", id, cols, rows } as PtySocketData,
    texts: [] as string[],
    bins: [] as Uint8Array[],
    closed: null as null | [number, string],
    buffered: 0,
    send(s: string) { this.texts.push(s); },
    sendBinary(b: Uint8Array) { this.bins.push(b); },
    close(code: number, reason: string) { this.closed = [code, reason]; },
    getBufferedAmount() { return this.buffered; },
    output() { return new TextDecoder().decode(Buffer.concat(this.bins)); },
  };
  return ws;
}
type FWs = ReturnType<typeof fakeWs>;
const asWs = (w: FWs) => w as unknown as Parameters<PtyManager["open"]>[0];

async function until(cond: () => boolean, ms = 10000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await Bun.sleep(20);
  }
}

let cwd = "";
let mgr: PtyManager | null = null;
afterEach(async () => {
  mgr?.killAll();
  mgr = null;
  if (cwd) await rm(cwd, { recursive: true, force: true });
  cwd = "";
});
async function manager() {
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), "cv-ptyc-")));
  mgr = new PtyManager({ shell: "/bin/sh", cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color", PS1: "$ " } });
  return mgr;
}

test("a session runs a shell in cwd, echoes input, and survives detach with replay on reattach", async () => {
  const m = await manager();
  const a = fakeWs("s1");
  m.open(asWs(a));
  m.message(asWs(a), Buffer.from("pwd; echo MARK$((20+22))\n"));
  await until(() => a.output().includes("MARK42"));
  expect(a.output()).toContain(cwd);

  m.close(asWs(a)); // page reload: session keeps running
  const b = fakeWs("s1");
  m.open(asWs(b));
  expect(b.texts).toContain(JSON.stringify({ t: "replay" }));
  expect(b.output()).toContain("MARK42");
  m.message(asWs(b), Buffer.from("echo AFTER$((1+1))\n"));
  await until(() => b.output().includes("AFTER2"));
});

test("a second client replaces the first (closed with 4000)", async () => {
  const m = await manager();
  const a = fakeWs("s2");
  const b = fakeWs("s2");
  m.open(asWs(a));
  m.open(asWs(b));
  expect(a.closed).toEqual([4000, "replaced"]);
  expect(b.closed).toBeNull();
});

test("resize control messages are clamped and applied; bad messages are ignored", async () => {
  const m = await manager();
  const a = fakeWs("s3");
  m.open(asWs(a));
  m.message(asWs(a), JSON.stringify({ t: "resize", cols: 5000, rows: 0.5 }));
  expect(a.data.cols).toBe(1000);
  expect(a.data.rows).toBe(1);
  m.message(asWs(a), JSON.stringify({ t: "resize", cols: 1, rows: 9999 }));
  expect(a.data.cols).toBe(2);
  expect(a.data.rows).toBe(500);
  m.message(asWs(a), JSON.stringify({ t: "resize", cols: 100, rows: 30 }));
  m.message(asWs(a), "{not json");
  m.message(asWs(a), JSON.stringify({ t: "resize" })); // missing dims: ignored
  m.message(asWs(a), JSON.stringify({ t: "nonsense" }));
  expect(a.data).toMatchObject({ cols: 100, rows: 30 });
  m.message(asWs(a), Buffer.from("stty size\n"));
  await until(() => a.output().includes("30 100"));
});

test("messages for unknown sessions are dropped", async () => {
  const m = await manager();
  const ghost = fakeWs("nobody");
  expect(() => {
    m.message(asWs(ghost), "hello");
    m.message(asWs(ghost), Buffer.from("x"));
    m.drain(asWs(ghost));
    m.close(asWs(ghost));
  }).not.toThrow();
});

test("shell exit sends the exit notice, closes the socket and forgets the session", async () => {
  const m = await manager();
  const a = fakeWs("s4");
  m.open(asWs(a));
  m.message(asWs(a), Buffer.from("echo BYE; exit 3\n"));
  await until(() => a.closed !== null);
  expect(a.closed).toEqual([1000, "exited"]);
  expect(a.texts).toContain(JSON.stringify({ t: "exit", code: 3 }));
  expect(a.output()).toContain("BYE");
  // a new connection with the same id starts a fresh shell
  const b = fakeWs("s4");
  m.open(asWs(b));
  m.message(asWs(b), Buffer.from("echo FRESH\n"));
  await until(() => b.output().includes("FRESH"));
  expect(b.texts.some((t) => t.includes('"exit"'))).toBe(false);
});

test("kill control message hangs the shell up", async () => {
  const m = await manager();
  const a = fakeWs("s5");
  m.open(asWs(a));
  m.message(asWs(a), Buffer.from("echo READY\n"));
  await until(() => a.output().includes("READY"));
  m.message(asWs(a), JSON.stringify({ t: "kill" }));
  await until(() => a.closed !== null);
  expect(a.texts.some((t) => t.includes('"exit"'))).toBe(true);
  // input after exit is ignored, not thrown
  expect(() => m.message(asWs(a), Buffer.from("x"))).not.toThrow();
});

test("private modes are restored ahead of the replay (alt screen, bracketed paste)", async () => {
  const m = await manager();
  const a = fakeWs("s6");
  m.open(asWs(a));
  m.message(asWs(a), Buffer.from("printf '\\033[?1049h\\033[?2004h\\033[?25lDONE1\\n'\n"));
  await until(() => a.output().includes("DONE1"));
  m.close(asWs(a));
  const b = fakeWs("s6");
  m.open(asWs(b));
  // the replay stream begins with whichever modes were active at the start of the retained
  // output; after leaving the alt screen the prefix must follow the toggles
  m.message(asWs(b), Buffer.from("printf '\\033[?1049l\\033[?2004lDONE2\\n'\n"));
  await until(() => b.output().includes("DONE2"));
  m.close(asWs(b));
  const c = fakeWs("s6");
  m.open(asWs(c));
  const out = c.output();
  expect(out).toContain("DONE1");
  expect(out).toContain("DONE2");
});

test("large output is coalesced into frames and bounded by the replay ring", async () => {
  const m = await manager();
  const a = fakeWs("s7");
  m.open(asWs(a));
  // ~2 MB of numbered lines
  m.message(asWs(a), Buffer.from("i=0; while [ $i -lt 40000 ]; do echo \"line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"; i=$((i+1)); done; echo ENDMARK$((7*6))\n"));
  await until(() => a.output().includes("ENDMARK42"), 30000);
  expect(a.bins.length).toBeGreaterThan(1);
  m.close(asWs(a));
  const b = fakeWs("s7");
  m.open(asWs(b));
  const total = b.bins.reduce((n, x) => n + x.length, 0);
  expect(total).toBeLessThanOrEqual(512 * 1024 + 4096);
  expect(total).toBeGreaterThan(256 * 1024);
  const text = b.output();
  expect(text).toContain("ENDMARK42");
  expect(text.startsWith("line-0-")).toBe(false); // oldest output was trimmed
  // trimmed replay starts on a line boundary
  expect(/^(\x1b\[\?\d+h)*line-\d+-/.test(text)).toBe(true);
});

test("a lagging client stops receiving live data and is resynced once its socket drains", async () => {
  const m = await manager();
  const a = fakeWs("s8");
  m.open(asWs(a));
  a.buffered = 9 * 1024 * 1024; // above HIGH_WATER after the next flush
  m.message(asWs(a), Buffer.from("echo FIRST\n"));
  await until(() => a.output().includes("FIRST"));
  const framesWhenLagging = a.bins.length;
  m.message(asWs(a), Buffer.from("echo SECOND\n"));
  await Bun.sleep(300);
  expect(a.bins.length).toBe(framesWhenLagging); // live stream paused
  m.drain(asWs(a)); // still above the low-water mark: nothing happens
  expect(a.bins.length).toBe(framesWhenLagging);
  a.buffered = 0;
  m.drain(asWs(a));
  expect(a.texts.filter((t) => t.includes("replay")).length).toBe(1); // resync (nothing to replay on the first attach)
  expect(a.output()).toContain("SECOND");
  m.drain(asWs(a)); // not lagging anymore: no-op
  expect(a.texts.filter((t) => t.includes("replay")).length).toBe(1);
});

test("an exit with nobody attached is kept: the next attach gets replay + exit notice, then the id is free", async () => {
  const m = await manager();
  const a = fakeWs("s8");
  m.open(asWs(a));
  m.message(asWs(a), Buffer.from("echo READY\n"));
  await until(() => a.output().includes("READY"));
  m.message(asWs(a), Buffer.from("echo LAST; exit 5\n"));
  m.close(asWs(a)); // detached before the shell can exit
  expect(a.closed).toBeNull();
  await Bun.sleep(400);
  const b = fakeWs("s8");
  m.open(asWs(b));
  expect(b.texts[0]).toBe(JSON.stringify({ t: "replay" }));
  expect(b.texts).toContain(JSON.stringify({ t: "exit", code: 5 }));
  expect(b.closed).toEqual([1000, "exited"]);
  expect(b.output()).toContain("LAST");
  // the socket that left never hears about it
  expect(a.texts.some((t) => t.includes('"exit"'))).toBe(false);
  const c = fakeWs("s8");
  m.open(asWs(c));
  m.message(asWs(c), Buffer.from("echo FRESH\n"));
  await until(() => c.output().includes("FRESH"));
  expect(c.texts.some((t) => t.includes('"exit"'))).toBe(false);
});
