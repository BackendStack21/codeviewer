import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server/http.ts";

// Every route the server has, discovered from its source: a route added later is covered by the
// same auth, Host, CSRF and header rules without anyone remembering to add it here.

const fetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch;
const token = "R".repeat(43);
let dir = "";
let cfg = "";
let app: ReturnType<typeof startServer>;
let base = "";
let port = 0;
let ROUTES: string[] = [];
const saved: Record<string, string | undefined> = {};

const fake = {
  install: { kind: "source" },
  installing: false,
  check: async () => ({ current: "0", latest: null, available: false, kind: "source", canInstall: false, checkedAt: 0 }),
  apply: async () => {
    throw new Error("not in tests");
  },
};

beforeAll(async () => {
  for (const k of ["XDG_CONFIG_HOME", "CODEVIEWER_NO_UPDATE_CHECK"]) saved[k] = process.env[k];
  cfg = await realpath(await mkdtemp(path.join(tmpdir(), "cv-routes-cfg-")));
  process.env.XDG_CONFIG_HOME = cfg;
  process.env.CODEVIEWER_NO_UPDATE_CHECK = "1";
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-routes-")));
  await writeFile(path.join(dir, "a.txt"), "hello\n");
  app = startServer({ root: dir, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {}, updater: fake as never });
  port = app.server.port!;
  base = `http://127.0.0.1:${port}`;
  const src = await readFile(path.join(import.meta.dir, "..", "src", "server", "http.ts"), "utf8");
  ROUTES = [...new Set([...src.matchAll(/case "(\/api\/[^"]+)":/g)].map((m) => m[1]!))];
});

afterAll(async () => {
  app.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
  await rm(cfg, { recursive: true, force: true });
});

const expectSecurityHeaders = (r: Response, what: string) => {
  const ctx = `${what}: ${r.status}`;
  expect([ctx, r.headers.get("x-content-type-options")]).toEqual([ctx, "nosniff"]);
  expect([ctx, r.headers.get("x-frame-options")]).toEqual([ctx, "DENY"]);
  expect([ctx, r.headers.get("referrer-policy")]).toEqual([ctx, "no-referrer"]);
  expect([ctx, (r.headers.get("content-type") ?? "").includes("text/html")]).toEqual([ctx, false]);
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

describe("every API route", () => {
  test("the route list was found (the source format is still what this test parses)", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(15);
    for (const r of ["/api/file", "/api/raw", "/api/open", "/api/settings", "/api/update/install"]) expect(ROUTES).toContain(r);
  });

  test("refuses every method without the session token: 401 JSON with the security headers", async () => {
    for (const p of ROUTES) {
      for (const method of METHODS) {
        const r = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
        expect([p, method, r.status]).toEqual([p, method, 401]);
        expectSecurityHeaders(r, `${method} ${p}`);
        expect(await r.json()).toEqual({ error: "unauthorized" });
      }
    }
  });

  test("a token in the query string, a cookie or a wrong token is not a credential", async () => {
    for (const p of ROUTES) {
      for (const headers of [{}, { cookie: `t=${token}` }, { "x-cv-token": token.slice(1) }, { "x-cv-token": token + "x" }, { "x-cv-token": "" }]) {
        const r = await fetch(`${base}${p}?t=${token}&token=${token}`, { headers });
        expect([p, r.status]).toEqual([p, 401]);
      }
    }
  });

  test("the terminal's open-only token reaches POST /api/open and nothing else", async () => {
    for (const p of ROUTES) {
      for (const method of METHODS) {
        const r = await fetch(`${base}${p}`, {
          method,
          headers: { "x-cv-token": app.openToken, "content-type": "application/json" },
          body: method === "GET" ? undefined : JSON.stringify({ path: "a.txt" }),
        });
        const allowed = p === "/api/open";
        expect([p, method, r.status === 401]).toEqual([p, method, !allowed]);
      }
    }
    // Prefix and normalization tricks do not stretch it either.
    for (const p of ["//api/open", "/api/open/", "/api/open/../info", "/API/OPEN", "/api/%6fpen", "/ws/../api/info", "/api/open?x=/api/info"]) {
      const r = await fetch(`${base}${p}`, { method: "POST", headers: { "x-cv-token": app.openToken, "content-type": "application/json" }, body: "{}" });
      // Only a request that the server routes to /api/open gets past auth (then 400: no path).
      // Bun collapses repeated slashes, so "//api/open" is that route too; nothing else is.
      const routed = new URL(base + p).pathname.replace(/\/{2,}/g, "/") === "/api/open";
      expect([p, r.status]).toEqual([p, routed ? 400 : 401]);
      const info = await fetch(`${base}${p}`, { headers: { "x-cv-token": app.openToken } });
      expect([p, info.status === 200 && (await info.text()).includes('"root"')]).toEqual([p, false]);
    }
  });

  test("a foreign Host header is refused before anything else (DNS rebinding)", async () => {
    for (const p of ["/", "/app.js", ...ROUTES, "/ws/events"]) {
      for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost`, `127.0.0.1:${port + 1}`, `[::ffff:127.0.0.1]:${port}`]) {
        const r = await fetch(`${base}${p}`, { headers: { "x-cv-token": token, host } });
        expect([p, host, r.status]).toEqual([p, host, 421]);
      }
    }
  });

  test("writes need application/json (a cross-site form or no-cors fetch cannot send it)", async () => {
    for (const p of ROUTES) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const type of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain; charset=application/json"]) {
          const headers: Record<string, string> = { "x-cv-token": token };
          if (type) headers["content-type"] = type;
          const r = await fetch(`${base}${p}`, { method, headers, body: "{}" });
          expect([p, method, type, r.status]).toEqual([p, method, type, 415]);
          expectSecurityHeaders(r, `${method} ${p} (${type})`);
        }
      }
    }
  });

  test("authenticated GETs never fail with a 5xx or an HTML page, and carry the security headers", async () => {
    for (const p of ROUTES) {
      const r = await fetch(`${base}${p}`, { headers: { "x-cv-token": token } });
      expect([p, r.status < 500]).toEqual([p, true]);
      expectSecurityHeaders(r, `GET ${p}`);
      await r.arrayBuffer();
    }
  });

  test("unknown paths are a JSON 404 after auth, never a fallthrough to the app shell", async () => {
    for (const p of ["/api/nope", "/api/file/x", "/api", "/api/", "/ws/nope", "/index.html/x"]) {
      const r = await fetch(`${base}${p}`, { headers: { "x-cv-token": token } });
      expect([p, r.status]).toEqual([p, 404]);
      expectSecurityHeaders(r, `GET ${p}`);
    }
  });
});

describe("WebSocket routes", () => {
  test("upgrades need the token and our own Origin", async () => {
    const tryWs = (url: string, origin?: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(url, origin ? ({ headers: { origin } } as never) : undefined);
        ws.onopen = () => {
          ws.close();
          resolve("open");
        };
        ws.onerror = () => resolve("refused");
        setTimeout(() => resolve("timeout"), 3000);
      });
    const ws = `ws://127.0.0.1:${port}`;
    expect(await tryWs(`${ws}/ws/events`)).toBe("refused");
    expect(await tryWs(`${ws}/ws/events?t=${app.openToken}`)).toBe("refused");
    expect(await tryWs(`${ws}/ws/events?t=${token}`, "https://evil.example")).toBe("refused");
    expect(await tryWs(`${ws}/ws/events?t=${token}`, "null")).toBe("refused");
    expect(await tryWs(`${ws}/ws/events?t=${token}`, `http://127.0.0.1:${port}`)).toBe("open");
    expect(await tryWs(`${ws}/ws/pty?id=x&t=${token}`, `http://127.0.0.1:${port}`)).toBe("refused"); // id too short
  });
});

describe("the app shell", () => {
  test("is public but can never be framed, and runs only its own script", async () => {
    for (const p of ["/", "/index.html", "/app.js", "/app.css", "/favicon.svg"]) {
      const r = await fetch(`${base}${p}`);
      expect([p, r.status]).toEqual([p, 200]);
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      const csp = r.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("script-src 'self';");
      expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|\*/);
      await r.arrayBuffer();
    }
  });
});
