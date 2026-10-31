import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { startServer } from "../src/server/http.ts";

// RED test for the 2026-10 security review: when the server binds a non-loopback
// host, hostOk() (http.ts:115-119) short-circuits to true, so the only DNS-rebinding
// / cross-site-WebSocket guard left is the Origin check at http.ts:266 — which
// compares Origin against the request's own Host header. An attacker page on
// attacker.example that connects to <lan-ip>:<port> with Host: attacker.example:port
// sends Origin http://attacker.example:port, the two match, and the upgrade is
// accepted. The Origin check must compare against the server's own origin
// (scheme + bound host + port), not the client-controlled Host.
const token = "S".repeat(43);

let dir = "";
let app: ReturnType<typeof startServer>;
let port = 0;

/** Raw HTTP/1.1 upgrade request; returns the response status line. */
const upgrade = (host: string, origin: string | null) =>
  new Promise<string>((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      const lines = [
        "GET /ws/events?t=" + token + " HTTP/1.1",
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
      ];
      if (origin) lines.push(`Origin: ${origin}`);
      sock.write(lines.join("\r\n") + "\r\n\r\n");
    });
    sock.once("data", (d) => {
      resolve(d.toString("latin1").split("\r\n")[0]!);
      sock.destroy();
    });
    sock.once("error", reject);
    setTimeout(() => { sock.destroy(); reject(new Error("timeout")); }, 5000).unref();
  });

beforeAll(async () => {
  process.env.CODEVIEWER_NO_UPDATE_CHECK = "1";
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-wsorigin-")));
  await mkdir(path.join(dir, "sub"));
  await writeFile(path.join(dir, "a.txt"), "line1\n");
  app = startServer({ root: dir, port: 0, host: "0.0.0.0", shell: "/bin/sh", token });
  port = app.server.port!;
});

afterAll(async () => {
  app.stop();
  await rm(dir, { recursive: true, force: true });
});

test("a WS upgrade whose Origin matches a spoofed Host header is rejected", async () => {
  // DNS-rebinding shape: attacker-controlled hostname in both Host and Origin.
  const status = await upgrade("attacker.example:1", "http://attacker.example:1");
  expect(status).toContain("403");
});

test("a WS upgrade with the server's real origin is still accepted", async () => {
  const status = await upgrade(`127.0.0.1:${port}`, `http://127.0.0.1:${port}`);
  expect(status).toContain("101");
});
