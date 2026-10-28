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
