import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server/http.ts";
import { Terminal } from "../src/client/term/terminal.ts";

let dir = "";
let app: ReturnType<typeof startServer>;
const token = "P".repeat(43);

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-pty-")));
  app = startServer({ root: dir, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {} });
});
afterAll(async () => {
  app.stop();
  await rm(dir, { recursive: true, force: true });
});

/** A headless client: real emulator, replay handled like the UI does. */
function connect(id: string) {
  const port = app.server.port!;
  const term = new Terminal(80, 24, { reply: () => {} });
  let frames = 0;
  let replay = false;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?id=${id}&cols=80&rows=24&t=${token}`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  } as never);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      if (e.data.includes("replay")) {
        term.reset();
        replay = true;
      }
      return;
    }
    frames++;
    term.silent = replay;
    term.write(new Uint8Array(e.data as ArrayBuffer));
    term.silent = replay = false;
  };
  const opened = new Promise((r) => (ws.onopen = r));
  const send = (s: string) => ws.send(new TextEncoder().encode(s));
  return { ws, term, opened, send, frames: () => frames };
}

test("a reload restores alt screen, bracketed paste and mouse modes even after history was trimmed", async () => {
  const a = connect("modes-test-1");
  await a.opened;
  // Enter the modes, then push far more than the 512 KB replay window.
  a.send(`printf '\\033[?2004h\\033[?1049h\\033[?1000h'; i=0; while [ $i -lt 9000 ]; do echo "line $i ............................................................"; i=$((i+1)); done; echo DONE\n`);
  for (let i = 0; i < 100 && !a.term.lines.some((l) => l.toString() === "DONE"); i++) await Bun.sleep(100);
  expect(a.term.modes.bracketedPaste).toBe(true);
  a.ws.close();
  await Bun.sleep(200);

  const b = connect("modes-test-1");
  await b.opened;
  await Bun.sleep(600);
  expect(b.term.alt).toBe(true);
  expect(b.term.modes.bracketedPaste).toBe(true);
  expect(b.term.modes.mouse).toBe(1000);
  expect(b.term.lines.some((l) => l.toString() === "DONE")).toBe(true);
  b.send("exit\n");
  b.ws.close();
}, 30_000);

test("output is coalesced into few frames", async () => {
  const c = connect("coalesce-test-1");
  await c.opened;
  c.send(`i=0; while [ $i -lt 20000 ]; do echo y; i=$((i+1)); done; echo END\n`);
  for (let i = 0; i < 100 && !c.term.lines.some((l) => l.toString() === "END"); i++) await Bun.sleep(100);
  // 20k tiny writes must not become 20k WebSocket messages.
  expect(c.frames()).toBeLessThan(2000);
  c.send("exit\n");
  c.ws.close();
}, 30_000);

test("a shell that exits while nobody is attached still delivers its last output and exit code on reattach", async () => {
  const a = connect("exit-while-detached-1");
  await a.opened;
  a.send("echo READY\n");
  for (let i = 0; i < 100 && !a.term.lines.some((l) => l.toString() === "READY"); i++) await Bun.sleep(100);
  // The exit lands after the socket is gone (a reload in the middle of it).
  a.send("echo LAST; sleep 0.2; exit 7\n");
  a.ws.close();
  await Bun.sleep(300);

  const b = connect("exit-while-detached-1");
  const texts: string[] = [];
  const closed = new Promise<CloseEvent>((r) => (b.ws.onclose = r));
  const inner = b.ws.onmessage!;
  b.ws.onmessage = (e) => {
    if (typeof e.data === "string") texts.push(e.data);
    inner.call(b.ws, e);
  };
  await b.opened;
  const ev = await closed;
  expect(ev.code).toBe(1000);
  expect(texts[0]).toBe(JSON.stringify({ t: "replay" }));
  expect(texts).toContain(JSON.stringify({ t: "exit", code: 7 }));
  expect(b.term.lines.some((l) => l.toString() === "LAST")).toBe(true);

  // After that the id is free: a new attach starts a fresh shell with no stale exit notice.
  const c = connect("exit-while-detached-1");
  const cTexts: string[] = [];
  const cInner = c.ws.onmessage!;
  c.ws.onmessage = (e) => {
    if (typeof e.data === "string") cTexts.push(e.data);
    cInner.call(c.ws, e);
  };
  await c.opened;
  c.send("echo FRESH\n");
  for (let i = 0; i < 100 && !c.term.lines.some((l) => l.toString() === "FRESH"); i++) await Bun.sleep(100);
  expect(c.term.lines.some((l) => l.toString() === "FRESH")).toBe(true);
  expect(cTexts.some((t) => t.includes('"exit"'))).toBe(false);
  c.send("exit\n");
  c.ws.close();
}, 30_000);

test("terminals get the narrow open token, never the session token", async () => {
  const a = connect("env-token-1");
  await a.opened;
  a.send("echo TOK=$CODEVIEWER_TOKEN\n");
  for (let i = 0; i < 100 && !a.term.lines.some((l) => l.toString().startsWith("TOK=")); i++) await Bun.sleep(100);
  const line = a.term.lines.map((l) => l.toString()).find((l) => l.startsWith("TOK=") && !l.includes("$"))!;
  expect(line).toBe(`TOK=${app.openToken}`);
  expect(line).not.toContain(token);
  a.send("exit\n");
  a.ws.close();
}, 30_000);
