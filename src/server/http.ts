import type { Server, ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { stat } from "node:fs/promises";
import { listDir, readForView, resolveSafe, imageMime, toRel, looksBinary, openRegular, MAX_TEXT_BYTES } from "./files.ts";
import { FileIndex } from "./index.ts";
import { watchTree } from "./watch.ts";
import { PtyManager, type PtySocketData } from "./pty.ts";
import { loadAssets, FONTS, type Asset } from "./assets.ts";
import { Settings } from "./settings.ts";
import { Git } from "./git.ts";
import { Updater } from "./update.ts";
import { Candidates, compileQuery, globsOk, createWorkerScanner, type SearchEvent } from "./search.ts";

import pkg from "../../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

export interface ServeOptions {
  root: string; // realpath of the directory being viewed
  port: number;
  host: string;
  shell: string;
  token: string;
  /** Opens a URL in the user's default browser (external links from the app window). */
  openExternal(url: string): void;
  /** Restarts into a freshly installed version, when this process can (Linux app window). */
  relaunch?: { available(): boolean; run(): void };
  /** Injected for tests; defaults to the real updater. */
  updater?: Updater;
  /** Injected for tests: replaces the worker-backed search scanner. */
  searchScanner?: import("./search.ts").Scanner;
  /** Injected for tests: overrides SEARCH_DEADLINE_MS. */
  searchDeadlineMs?: number;
}

type EventsSocketData = { kind: "events" };
type SocketData = PtySocketData | EventsSocketData;

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export function startServer(opts: ServeOptions): { server: Server<SocketData>; url: string; stop(): void } {
  const assets = loadAssets();
  const index = new FileIndex(opts.root);
  const settings = new Settings();
  const updater = opts.updater ?? new Updater({ version: VERSION });
  // One background check per launch, unless turned off (setting or CODEVIEWER_NO_UPDATE_CHECK).
  const autoCheck = (async () => {
    if (process.env.CODEVIEWER_NO_UPDATE_CHECK) return null;
    const s = (await settings.read()) as { updates?: { auto?: boolean } };
    if (s.updates?.auto === false) return null;
    await Bun.sleep(3000);
    return updater.check().catch(() => null);
  })();
  const events = new Set<ServerWebSocket<SocketData>>();
  let origin = "";
  let port = 0;
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(opts.host);

  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    for (const ws of events) ws.send(s);
  };

  const gitReady = Git.open(opts.root).then((g) => {
    g?.watch((status) => broadcast({ t: "git", status }));
    return g;
  });

  const candidates = new Candidates(opts.root, index, gitReady);

  const stopWatch = watchTree(opts.root, async (paths) => {
    candidates.invalidate();
    const structural = await index.apply(paths);
    // Huge bursts (installs, builds) are summarized: the client refreshes what it shows.
    if (paths.length > 2000) broadcast({ t: "changed", paths: [], many: true, structural: true });
    else broadcast({ t: "changed", paths, structural });
    void gitReady.then((g) => g?.poke());
  });

  let ptys: PtyManager;

  const tokenOk = (candidate: string | null | undefined) => {
    if (!candidate || candidate.length !== opts.token.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(opts.token));
  };

  /**
   * Auth is a header (or, for WebSocket upgrades, a query parameter), never a cookie:
   * cookies are shared by every port on 127.0.0.1, and a header can't be forged by a
   * cross-site form. The page gets the token from the URL fragment, which is never sent
   * to any server.
   */
  const authed = (req: Request, url: URL) =>
    tokenOk(req.headers.get("x-cv-token")) || (url.pathname.startsWith("/ws/") && tokenOk(url.searchParams.get("t")));

  /** DNS-rebinding guard: only our own loopback host names (unless --host opened it up). */
  const hostOk = (req: Request) => {
    if (!loopback) return true;
    const h = req.headers.get("host") ?? "";
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
  };

  const securityHeaders = (h: Headers) => {
    h.set("x-content-type-options", "nosniff");
    h.set("referrer-policy", "no-referrer");
    h.set("x-frame-options", "DENY");
    return h;
  };

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: securityHeaders(new Headers({ "content-type": "application/json" })) });
  const fail = (status: number, message: string) => json({ error: message }, status);

  const serveAsset = (req: Request, a: Asset) => {
    const h = securityHeaders(new Headers({ "content-type": a.type, etag: a.etag, "cache-control": "no-cache" }));
    h.set(
      "content-security-policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; ` +
        `connect-src 'self' ws://${req.headers.get("host") ?? ""}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
    );
    if (req.headers.get("if-none-match") === a.etag) return new Response(null, { status: 304, headers: h });
    if (a.gzip && (req.headers.get("accept-encoding") ?? "").includes("gzip")) {
      h.set("content-encoding", "gzip");
      return new Response(a.gzip as BodyInit, { headers: h });
    }
    return new Response(a.body, { headers: h });
  };

  const scanner = opts.searchScanner ?? createWorkerScanner(opts.searchDeadlineMs);
  let activeSearch: AbortController | null = null;

  /** GET /api/search: NDJSON stream; the newest search cancels the one before it. */
  const search = async (req: Request, url: URL): Promise<Response> => {
    const sp = url.searchParams;
    const q = sp.get("q") ?? "";
    const o = { regex: sp.get("regex") === "1", case: sp.get("case") === "1", word: sp.get("word") === "1" };
    const c = compileQuery(q, o);
    if (!c.ok) return fail(400, c.error);
    const include = sp.get("include") ?? "";
    const exclude = sp.get("exclude") ?? "";
    if (!globsOk(include) || !globsOk(exclude)) return fail(400, "Invalid include/exclude globs");

    activeSearch?.abort();
    const ac = new AbortController();
    activeSearch = ac;
    const onReqAbort = () => ac.abort();
    req.signal.addEventListener("abort", onReqAbort, { once: true });

    const lines: string[] = [];
    let finished = false;
    let failed = false;
    let wake: (() => void) | null = null;
    const poke = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const emit = (e: SearchEvent) => {
      lines.push(JSON.stringify(e) + "\n");
      poke();
    };
    const run = (async () => {
      const list = await candidates.list({ include, exclude, ignored: sp.get("ignored") === "1" });
      await scanner({ root: opts.root, files: list, q, opts: o }, ac.signal, emit);
    })()
      .catch(() => {
        failed = true;
      })
      .finally(() => {
        finished = true;
        if (activeSearch === ac) activeSearch = null;
        req.signal.removeEventListener("abort", onReqAbort);
        poke();
      });

    // A failure before any output becomes a clean 500 with a fixed string.
    while (!lines.length && !finished) await new Promise<void>((r) => (wake = r));
    if (!lines.length && failed) return fail(500, "search failed");

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        while (!lines.length && !finished) await new Promise<void>((r) => (wake = r));
        if (lines.length) return ctl.enqueue(enc.encode(lines.splice(0).join("")));
        ctl.close();
      },
      cancel() {
        ac.abort();
      },
    });
    void run;
    return new Response(stream, {
      headers: securityHeaders(new Headers({ "content-type": "application/x-ndjson", "cache-control": "no-store" })),
    });
  };

  const relParam = (url: URL) => url.searchParams.get("path") ?? "";

  const server = Bun.serve<SocketData>({
    port: opts.port,
    hostname: opts.host,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (!hostOk(req)) return fail(421, "unexpected host");

      // The app shell (HTML/JS/CSS/fonts) is public and contains no secrets.
      const asset = assets[p === "/" ? "/index.html" : p];
      if (asset) return serveAsset(req, asset);
      if (FONTS[p]) {
        return new Response(Bun.file(FONTS[p]!), {
          headers: securityHeaders(new Headers({ "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" })),
        });
      }

      if (!authed(req, url)) return fail(401, "unauthorized");
      // Writes must be JSON: forms can't send it cross-site without a CORS preflight.
      if (req.method !== "GET" && !(req.headers.get("content-type") ?? "").startsWith("application/json")) {
        return fail(415, "application/json required");
      }

      if (p.startsWith("/ws/")) {
        // Cross-site WebSocket hijacking guard: browsers always send Origin; it must be us.
        const o = req.headers.get("origin");
        if (o && o !== `http://${req.headers.get("host")}`) return fail(403, "bad origin");
        if (p === "/ws/events") {
          return srv.upgrade(req, { data: { kind: "events" } }) ? undefined : fail(400, "upgrade failed");
        }
        if (p === "/ws/pty") {
          const id = url.searchParams.get("id") ?? "";
          if (!/^[\w-]{6,64}$/.test(id)) return fail(400, "bad id");
          const cols = Math.max(2, Number(url.searchParams.get("cols")) || 80);
          const rows = Math.max(1, Number(url.searchParams.get("rows")) || 24);
          return srv.upgrade(req, { data: { kind: "pty", id, cols, rows } }) ? undefined : fail(400, "upgrade failed");
        }
        return fail(404, "not found");
      }

      switch (p) {
        case "/api/info":
          return json({
            name: path.basename(opts.root) || opts.root,
            root: opts.root,
            version: VERSION,
            platform: process.platform,
            shell: path.basename(opts.shell),
            maxText: MAX_TEXT_BYTES,
          });

        case "/api/list": {
          const abs = await resolveSafe(opts.root, relParam(url));
          if (!abs) return fail(404, "not found");
          try {
            return json(await listDir(abs));
          } catch (e) {
            return fail(400, (e as Error).message);
          }
        }

        case "/api/stat": {
          const abs = await resolveSafe(opts.root, relParam(url));
          if (!abs) return fail(404, "not found");
          const st = await stat(abs).catch(() => null);
          return st ? json({ type: st.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtimeMs }) : fail(404, "not found");
        }

        case "/api/file": {
          const abs = await resolveSafe(opts.root, relParam(url));
          if (!abs) return fail(404, "not found");
          try {
            const { meta, body } = await readForView(abs, url.searchParams.has("text"));
            const h = securityHeaders(
              new Headers({
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store",
                "x-cv-kind": meta.kind,
                "x-cv-size": String(meta.size),
                "x-cv-mtime": String(meta.mtime),
                "x-cv-truncated": meta.truncated ? "1" : "0",
                "x-cv-encoding": meta.encoding ?? "UTF-8",
              }),
            );
            return new Response((body ?? "") as BodyInit, { headers: h });
          } catch (e) {
            return fail(400, (e as Error).message);
          }
        }

        case "/api/raw": {
          const rel = relParam(url);
          const abs = await resolveSafe(opts.root, rel);
          if (!abs) return fail(404, "not found");
          const type = imageMime(rel) ?? MIME[rel.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
          const h = securityHeaders(new Headers({ "content-type": type, "cache-control": "no-store" }));
          // Even if an SVG is opened directly, it must not run script.
          h.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
          // Read through a verified regular-file handle (no FIFOs/devices, no symlink swaps).
          let opened;
          try {
            opened = await openRegular(abs);
          } catch (e) {
            return fail(400, (e as Error).message);
          }
          const limit = Number(url.searchParams.get("limit"));
          const size = limit > 0 ? Math.min(limit, opened.st.size) : opened.st.size;
          const fh = opened.fh;
          let pos = 0;
          const stream = new ReadableStream<Uint8Array>({
            async pull(ctl) {
              const chunk = new Uint8Array(Math.min(256 * 1024, size - pos));
              const { bytesRead } = chunk.length ? await fh.read(chunk, 0, chunk.length, pos) : { bytesRead: 0 };
              if (bytesRead === 0) {
                await fh.close();
                return ctl.close();
              }
              pos += bytesRead;
              ctl.enqueue(chunk.subarray(0, bytesRead));
            },
            async cancel() {
              await fh.close();
            },
          });
          h.set("content-length", String(size));
          return new Response(stream, { headers: h });
        }

        case "/api/search":
          return search(req, url);

        case "/api/index":
          return new Response(await index.get(), {
            headers: securityHeaders(new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })),
          });

        case "/api/git/status": {
          const g = await gitReady;
          return json(g ? await g.status() : { repo: false });
        }

        case "/api/git/base": {
          // HEAD version of a file, for gutter diffs. 404 = not tracked at HEAD.
          const g = await gitReady;
          const rel = relParam(url);
          if (!g || !(await resolveSafe(opts.root, rel))) return fail(404, "not tracked");
          const blob = await g.base(rel, MAX_TEXT_BYTES);
          if (!blob) return fail(404, "not tracked");
          if (looksBinary(blob)) return fail(415, "binary");
          return new Response(blob as BodyInit, {
            headers: securityHeaders(new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })),
          });
        }

        case "/api/git/blame": {
          const g = await gitReady;
          const rel = relParam(url);
          const line = Number(url.searchParams.get("line"));
          if (!g || !Number.isInteger(line) || line < 1 || !(await resolveSafe(opts.root, rel))) return fail(404, "no blame");
          const b = await g.blame(rel, line);
          return b ? json(b) : fail(404, "no blame");
        }

        case "/api/update": {
          // GET: status (?check=1 forces a fresh check). Never throws for offline users.
          if (url.searchParams.has("check")) {
            try {
              return json(await updater.check(true));
            } catch (e) {
              return fail(502, (e as Error).message);
            }
          }
          const info = await autoCheck;
          return json(info ?? { current: VERSION, latest: null, available: false, kind: updater.install.kind, canInstall: false, checkedAt: 0 });
        }

        case "/api/update/install": {
          if (req.method !== "POST") return fail(405, "POST only");
          if (updater.installing) return fail(409, "an update is already being installed");
          // Runs in the background; progress and the result arrive on the events socket.
          void updater
            .apply((phase, detail) => broadcast({ t: "update", phase, detail }))
            .then(
              (r) => broadcast({ t: "update", phase: "installed", detail: r.version, relaunch: r.kind === "macos-app" ? "native" : opts.relaunch?.available() ? "server" : "manual" }),
              (e: Error) => broadcast({ t: "update", phase: "error", detail: e.message }),
            );
          return json({ ok: true });
        }

        case "/api/update/relaunch": {
          if (req.method !== "POST") return fail(405, "POST only");
          if (!opts.relaunch?.available()) return fail(409, "restart codeviewer to use the new version");
          setTimeout(() => opts.relaunch?.run(), 150);
          return json({ ok: true });
        }

        case "/api/settings": {
          if (req.method === "GET") return json(await settings.read());
          if (req.method !== "PUT") return fail(405, "GET or PUT");
          const text = await req.text();
          if (text.length > 256 * 1024) return fail(413, "settings too large");
          try {
            await settings.write(JSON.parse(text));
          } catch {
            return fail(400, "invalid settings");
          }
          return json({ ok: true });
        }

        case "/api/external": {
          if (req.method !== "POST") return fail(405, "POST only");
          const body = (await req.json().catch(() => null)) as { url?: string } | null;
          let u: URL;
          try {
            u = new URL(body?.url ?? "");
          } catch {
            return fail(400, "invalid url");
          }
          if (u.protocol !== "http:" && u.protocol !== "https:") return fail(400, "only http(s) links can be opened");
          opts.openExternal(u.href);
          return json({ ok: true });
        }

        case "/api/open": {
          if (req.method !== "POST") return fail(405, "POST only");
          const body = (await req.json().catch(() => null)) as { path?: string; line?: number } | null;
          if (!body?.path) return fail(400, "missing path");
          const rel = path.isAbsolute(body.path) ? toRel(opts.root, body.path) : body.path;
          if (rel === null || !(await resolveSafe(opts.root, rel))) return fail(404, "path is outside the viewed directory");
          broadcast({ t: "open", path: rel, line: body.line ?? 0 });
          return json({ ok: true, clients: events.size });
        }
      }
      return fail(404, "not found");
    },

    websocket: {
      maxPayloadLength: 16 * 1024 * 1024,
      perMessageDeflate: false,
      open(ws) {
        if (ws.data.kind === "events") events.add(ws);
        else ptys.open(ws as ServerWebSocket<PtySocketData>);
      },
      message(ws, msg) {
        if (ws.data.kind === "pty") ptys.message(ws as ServerWebSocket<PtySocketData>, msg);
      },
      drain(ws) {
        if (ws.data.kind === "pty") ptys.drain(ws as ServerWebSocket<PtySocketData>);
      },
      close(ws) {
        if (ws.data.kind === "events") events.delete(ws);
        else ptys.close(ws as ServerWebSocket<PtySocketData>);
      },
    },
  });

  const hostForUrl = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
  port = server.port ?? 0;
  origin = `http://${hostForUrl.includes(":") ? `[${hostForUrl}]` : hostForUrl}:${port}`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "codeviewer",
    TERM_PROGRAM_VERSION: VERSION,
    CODEVIEWER_URL: origin,
    CODEVIEWER_TOKEN: opts.token,
  });
  ptys = new PtyManager({ shell: opts.shell, cwd: opts.root, env });

  return {
    server,
    url: `${origin}/#t=${opts.token}`,
    stop() {
      stopWatch();
      void gitReady.then((g) => g?.stop());
      ptys.killAll();
      server.stop(true);
    },
  };
}
