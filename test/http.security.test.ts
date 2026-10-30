import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server/http.ts";

let dir = "";
let app: ReturnType<typeof startServer>;
let base = "";
let port = 0;
const token = "T".repeat(43);
const auth = { "x-cv-token": token };

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-http-")));
  await writeFile(path.join(dir, "a.txt"), "hello");
  Bun.spawnSync(["mkfifo", path.join(dir, "fifo")]);
  app = startServer({ root: dir, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {} });
  port = app.server.port!;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  app.stop();
  await rm(dir, { recursive: true, force: true });
});

test("launch URL keeps the token in the fragment, never the query", () => {
  expect(app.url).toBe(`${base}/#t=${token}`);
});

test("the app shell is public; the API requires the header", async () => {
  expect((await fetch(`${base}/`)).status).toBe(200);
  expect((await fetch(`${base}/app.js`)).status).toBe(200);
  expect((await fetch(`${base}/api/info`)).status).toBe(401);
  expect((await fetch(`${base}/api/info`, { headers: { "x-cv-token": "nope" } })).status).toBe(401);
  expect((await fetch(`${base}/api/info`, { headers: auth })).status).toBe(200);
  // Cookies are not a credential any more (they leak across ports on 127.0.0.1).
  expect((await fetch(`${base}/api/info`, { headers: { cookie: `cv_${port}=${token}` } })).status).toBe(401);
  // Query tokens only work for WebSocket upgrades.
  expect((await fetch(`${base}/api/info?t=${token}`)).status).toBe(401);
});

test("DNS rebinding: foreign Host headers are refused", async () => {
  const r = await fetch(`${base}/api/info`, { headers: { ...auth, host: `evil.example:${port}` } });
  expect(r.status).toBe(421);
  expect((await fetch(`${base}/`, { headers: { host: "evil.example" } })).status).toBe(421);
});

test("writes must be JSON (no form-based CSRF)", async () => {
  const body = JSON.stringify({ url: "https://example.com" });
  expect((await fetch(`${base}/api/external`, { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body })).status).toBe(415);
  expect((await fetch(`${base}/api/settings`, { method: "PUT", headers: auth, body: "{}" })).status).toBe(415);
});

test("WebSockets need the token and a same-origin Origin", async () => {
  const tryWs = (url: string, origin: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(url, { headers: { origin } } as never);
      ws.onopen = () => {
        ws.close();
        resolve("open");
      };
      ws.onerror = () => resolve("refused");
    });
  const ws = `ws://127.0.0.1:${port}/ws/events`;
  expect(await tryWs(`${ws}?t=${token}`, base)).toBe("open");
  expect(await tryWs(ws, base)).toBe("refused");
  expect(await tryWs(`${ws}?t=${token}`, "http://evil.example")).toBe("refused");
  expect(await tryWs(`${ws}?t=${token}`, `http://localhost:${port + 1}`)).toBe("refused");
});

test("FIFOs and other special files are refused instead of hanging the server", async () => {
  const t0 = performance.now();
  const r = await fetch(`${base}/api/file?path=fifo`, { headers: auth });
  expect(r.status).toBe(400);
  expect((await fetch(`${base}/api/raw?path=fifo`, { headers: auth })).status).toBe(400);
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(await (await fetch(`${base}/api/file?path=a.txt`, { headers: auth })).text()).toBe("hello");
});

test("the terminal token only opens files: /api/open accepts it, everything else rejects it", async () => {
  const open = (t: string) =>
    fetch(`${base}/api/open`, { method: "POST", headers: { "x-cv-token": t, "content-type": "application/json" }, body: JSON.stringify({ path: "a.txt" }) });
  expect(app.openToken).not.toBe(token);
  expect(app.openToken.length).toBeGreaterThanOrEqual(40);
  expect((await open(app.openToken)).status).toBe(200);
  expect((await open(token)).status).toBe(200);
  expect((await open("nope")).status).toBe(401);
  expect((await fetch(`${base}/api/info`, { headers: { "x-cv-token": app.openToken } })).status).toBe(401);
  expect((await fetch(`${base}/api/file?path=a.txt`, { headers: { "x-cv-token": app.openToken } })).status).toBe(401);
  const refused = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events?t=${app.openToken}`, { headers: { origin: base } } as never);
    ws.onopen = () => {
      ws.close();
      resolve("open");
    };
    ws.onerror = () => resolve("refused");
  });
  expect(refused).toBe("refused");
});
