import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, realpath, symlink, readFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, VERSION } from "../src/server/http.ts";

// Captured at load: other test files may swap globalThis.fetch/WebSocket for mocks.
const fetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch;
const WebSocket = globalThis.WebSocket;
const token = "C".repeat(43);
const auth = { "x-cv-token": token };
const json = { ...auth, "content-type": "application/json" };

let dir = "";
let cfg = "";
let outside = "";
let app: ReturnType<typeof startServer>;
let base = "";
let port = 0;
const opened: string[] = [];
let relaunched = 0;
let relaunchOk = false;
const saved: Record<string, string | undefined> = {};

type Fake = { install: { kind: string }; installing: boolean; check(force?: boolean): Promise<unknown>; apply(cb: (p: string, d?: string) => void): Promise<unknown> };
let fake: Fake;
let checkMode: "ok" | "throw" = "ok";
let applyMode: "ok" | "throw" = "ok";

const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

const get = (p: string, h: Record<string, string> = auth) => fetch(`${base}${p}`, { headers: h });

beforeAll(async () => {
  for (const k of ["XDG_CONFIG_HOME", "CODEVIEWER_NO_UPDATE_CHECK"]) saved[k] = process.env[k];
  cfg = await realpath(await mkdtemp(path.join(tmpdir(), "cv-cfg-")));
  process.env.XDG_CONFIG_HOME = cfg;
  process.env.CODEVIEWER_NO_UPDATE_CHECK = "1";
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-httpcov-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "cv-out-")));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await mkdir(path.join(dir, "sub"));
  await writeFile(path.join(dir, "a.txt"), "line1\nline2\nline3\n");
  await writeFile(path.join(dir, "sub", "b.ts"), "export const b = 1;\n");
  await writeFile(path.join(dir, "bin.dat"), new Uint8Array([0, 1, 2, 3, 0, 0, 255]));
  await writeFile(path.join(dir, "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(path.join(dir, "doc.pdf"), "%PDF-1.4 fake");
  await writeFile(path.join(dir, "noext"), "x".repeat(1000));
  await symlink(path.join(outside, "secret.txt"), path.join(dir, "escape"));
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  await writeFile(path.join(dir, "a.txt"), "line1\nCHANGED\nline3\n");

  fake = {
    install: { kind: "cli" },
    installing: false,
    async check() {
      if (checkMode === "throw") throw new Error("offline");
      return { current: VERSION, latest: "9.9.9", available: true, kind: "cli", canInstall: true, checkedAt: 1 };
    },
    async apply(cb) {
      cb("download", "x");
      if (applyMode === "throw") throw new Error("boom");
      return { version: "9.9.9", kind: "cli", target: "/x" };
    },
  };
  app = startServer({
    root: dir, port: 0, host: "127.0.0.1", shell: "/bin/sh", token,
    openExternal: (u) => void opened.push(u),
    relaunch: { available: () => relaunchOk, run: () => void relaunched++ },
    updater: fake as never,
  });
  port = app.server.port!;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  app.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
  await rm(cfg, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** Opens an events socket and collects messages. */
async function events() {
  const msgs: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events?t=${token}`, { headers: { origin: base } } as never);
  ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws failed"));
  });
  const waitFor = async (pred: (m: any) => boolean, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = msgs.find(pred);
      if (m) return m;
      await Bun.sleep(20);
    }
    throw new Error("timeout waiting for message; got " + JSON.stringify(msgs));
  };
  return { ws, msgs, waitFor };
}

test("asset serving: security headers, CSP, etag 304, gzip", async () => {
  const r = await fetch(`${base}/`, { headers: { "accept-encoding": "identity" } });
  expect(r.status).toBe(200);
  expect(r.headers.get("x-frame-options")).toBe("DENY");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("content-security-policy")).toContain(`ws://127.0.0.1:${port}`);
  expect(r.headers.get("content-type")).toContain("text/html");
  const etag = r.headers.get("etag")!;
  expect(etag).toBeTruthy();
  const r304 = await fetch(`${base}/`, { headers: { "if-none-match": etag } });
  expect(r304.status).toBe(304);
  const gz = await fetch(`${base}/app.js`, { headers: { "accept-encoding": "gzip" }, decompress: false } as never);
  expect(gz.status).toBe(200);
  if (gz.headers.get("content-encoding")) expect(gz.headers.get("content-encoding")).toBe("gzip");
});

test("fonts are public, immutable and served as woff2", async () => {
  const r = await fetch(`${base}/fonts/InterVariable.woff2`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("font/woff2");
  expect(r.headers.get("cache-control")).toContain("immutable");
  expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(1000);
});

test("/api/info reports root, version, shell", async () => {
  const j = await (await get("/api/info")).json();
  expect(j.root).toBe(dir);
  expect(j.version).toBe(VERSION);
  expect(j.shell).toBe("sh");
  expect(j.name).toBe(path.basename(dir));
  expect(j.maxText).toBeGreaterThan(0);
});

test("/api/list lists a directory, 404 for escapes and missing paths", async () => {
  const root = await (await get("/api/list")).json();
  expect(root.map((e: any) => e.name)).toContain("sub");
  const sub = await (await get("/api/list?path=sub")).json();
  expect(sub.map((e: any) => e.name)).toEqual(["b.ts"]);
  expect((await get("/api/list?path=nope")).status).toBe(404);
  expect((await get("/api/list?path=../")).status).toBe(404);
  expect((await get("/api/list?path=escape")).status).toBe(404);
  // A file is not a directory.
  expect((await get("/api/list?path=a.txt")).status).toBe(400);
});

test("/api/stat distinguishes files and dirs", async () => {
  expect(await (await get("/api/stat?path=sub")).json()).toMatchObject({ type: "dir" });
  const f = await (await get("/api/stat?path=a.txt")).json();
  expect(f).toMatchObject({ type: "file", size: 20 });
  expect(f.mtime).toBeGreaterThan(0);
  expect((await get("/api/stat?path=missing")).status).toBe(404);
  expect((await get("/api/stat?path=escape")).status).toBe(404);
});

test("/api/file returns content with metadata headers, honours ?text", async () => {
  const r = await get("/api/file?path=a.txt");
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("x-cv-truncated")).toBe("0");
  expect(r.headers.get("x-cv-size")).toBe("20");
  expect(await r.text()).toBe("line1\nCHANGED\nline3\n");
  const b = await get("/api/file?path=bin.dat");
  expect(b.status).toBe(200);
  expect(b.headers.get("x-cv-kind")).not.toBe("text");
  expect((await get("/api/file?path=pic.svg")).headers.get("x-cv-kind")).toBe("image");
  const forced = await get("/api/file?path=pic.svg&text=1");
  expect(forced.headers.get("x-cv-kind")).toBe("text");
  expect(await forced.text()).toContain("<svg");
  await writeFile(path.join(dir, "u16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]));
  const u16 = await get("/api/file?path=u16.txt");
  expect(u16.headers.get("x-cv-encoding")).toBe("UTF-16 LE");
  expect(await u16.text()).toBe("hi");
  expect((await get("/api/file?path=missing")).status).toBe(404);
  expect((await get("/api/file?path=sub")).headers.get("x-cv-kind")).toBe("dir");
  expect((await get("/api/file?path=escape")).status).toBe(404);
});

test("/api/raw: mime types, CSP sandbox, content-length, ?limit, errors", async () => {
  const svg = await get("/api/raw?path=pic.svg");
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  expect(svg.headers.get("content-security-policy")).toContain("sandbox");
  expect((await svg.text()).startsWith("<svg")).toBe(true);
  const pdf = await get("/api/raw?path=doc.pdf");
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect((await pdf.text()).length).toBe(13);
  const none = await get("/api/raw?path=noext");
  expect(none.headers.get("content-type")).toBe("application/octet-stream");
  expect((await none.text()).length).toBe(1000);
  const lim = await get("/api/raw?path=noext&limit=10");
  expect(await lim.text()).toBe("x".repeat(10));
  const big = await get("/api/raw?path=noext&limit=999999");
  expect((await big.text()).length).toBe(1000);
  // ?max refuses a larger file before sending a byte; at or under the cap it streams as usual.
  expect((await get("/api/raw?path=noext&max=999")).status).toBe(413);
  expect(await (await get("/api/raw?path=noext&max=1000")).text()).toBe("x".repeat(1000));
  expect((await get("/api/raw?path=missing")).status).toBe(404);
  expect((await get("/api/raw?path=sub")).status).toBe(400);
  expect((await get("/api/raw?path=escape")).status).toBe(404);
});

test("/api/raw streams files larger than one chunk and supports cancel", async () => {
  const big = path.join(dir, "big.bin");
  const data = new Uint8Array(600 * 1024).map((_, i) => i % 251);
  await writeFile(big, data);
  const r = await get("/api/raw?path=big.bin");
  const buf = new Uint8Array(await r.arrayBuffer());
  expect(buf.length).toBe(data.length);
  expect(buf[300000]).toBe(data[300000]!);
  // Abort mid-stream: the server must stay healthy.
  const r2 = await get("/api/raw?path=big.bin");
  await r2.body!.cancel();
  expect((await get("/api/info")).status).toBe(200);
});

test("/api/index lists files, skipping heavy dirs", async () => {
  const txt = await (await get("/api/index")).text();
  const lines = txt.split("\n");
  expect(lines).toContain("a.txt");
  expect(lines).toContain("sub/b.ts");
  expect(lines.some((l) => l.startsWith(".git/"))).toBe(false);
});

test("git endpoints: status, base, blame", async () => {
  const st = await (await get("/api/git/status")).json();
  expect(st.repo).toBe(true);
  const base1 = await get("/api/git/base?path=a.txt");
  expect(base1.status).toBe(200);
  expect(await base1.text()).toBe("line1\nline2\nline3\n");
  expect((await get("/api/git/base?path=nope.txt")).status).toBe(404);
  expect((await get("/api/git/base?path=escape")).status).toBe(404);
  expect((await get("/api/git/base?path=bin.dat")).status).toBe(415);
  const bl = await get("/api/git/blame?path=a.txt&line=1");
  expect(bl.status).toBe(200);
  expect((await get("/api/git/blame?path=a.txt&line=0")).status).toBe(404);
  expect((await get("/api/git/blame?path=a.txt&line=abc")).status).toBe(404);
  expect((await get("/api/git/blame?path=a.txt&line=1.5")).status).toBe(404);
  expect((await get("/api/git/blame?path=escape&line=1")).status).toBe(404);
});

test("/api/update: status (auto-check disabled), forced check, check failure", async () => {
  const s = await (await get("/api/update")).json();
  expect(s).toMatchObject({ current: VERSION, latest: null, available: false, canInstall: false, kind: "cli" });
  const c = await (await get("/api/update?check=1")).json();
  expect(c).toMatchObject({ latest: "9.9.9", available: true });
  checkMode = "throw";
  try {
    const r = await get("/api/update?check=1");
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("offline");
  } finally {
    checkMode = "ok";
  }
});

test("/api/update/install: method, busy, success and failure are broadcast", async () => {
  const post = () => fetch(`${base}/api/update/install`, { method: "POST", headers: json, body: "{}" });
  fake.installing = true;
  expect((await post()).status).toBe(409);
  fake.installing = false;

  const ev = await events();
  try {
    expect(await (await post()).json()).toEqual({ ok: true });
    await ev.waitFor((m) => m.t === "update" && m.phase === "download");
    const done = await ev.waitFor((m) => m.t === "update" && m.phase === "installed");
    expect(done.detail).toBe("9.9.9");
    expect(done.relaunch).toBe("manual");
    relaunchOk = true;
    ev.msgs.length = 0;
    await post();
    expect((await ev.waitFor((m) => m.phase === "installed")).relaunch).toBe("server");
    relaunchOk = false;
    ev.msgs.length = 0;
    applyMode = "throw";
    await post();
    const err = await ev.waitFor((m) => m.phase === "error");
    expect(err.detail).toBe("boom");
    // macOS app installs restart natively.
    applyMode = "ok";
    fake.apply = async () => ({ version: "9.9.9", kind: "macos-app", target: "/x" });
    ev.msgs.length = 0;
    await post();
    expect((await ev.waitFor((m) => m.phase === "installed")).relaunch).toBe("native");
  } finally {
    applyMode = "ok";
    ev.ws.close();
  }
});

test("/api/update/relaunch: only POST, only when available", async () => {
  const post = () => fetch(`${base}/api/update/relaunch`, { method: "POST", headers: json, body: "{}" });
  expect((await post()).status).toBe(409);
  relaunchOk = true;
  try {
    expect(await (await post()).json()).toEqual({ ok: true });
    await Bun.sleep(400);
    expect(relaunched).toBe(1);
  } finally {
    relaunchOk = false;
  }
  // Non-POST with a JSON content type hits the 405 branch (GET is exempt from the content-type check).
  expect((await get("/api/update/relaunch")).status).toBe(405);
  expect((await get("/api/update/install")).status).toBe(405);
});

test("/api/settings: round-trip, validation, size limit, method check", async () => {
  expect(await (await get("/api/settings")).json()).toEqual({});
  const put = (body: string) => fetch(`${base}/api/settings`, { method: "PUT", headers: json, body });
  expect((await put(JSON.stringify({ theme: "dark" }))).status).toBe(200);
  expect(await (await get("/api/settings")).json()).toEqual({ theme: "dark" });
  expect(JSON.parse(await readFile(path.join(cfg, "codeviewer", "settings.json"), "utf8"))).toEqual({ theme: "dark" });
  expect((await put("not json")).status).toBe(400);
  expect((await put("[1,2]")).status).toBe(400);
  expect((await put(JSON.stringify({ x: "y".repeat(300 * 1024) }))).status).toBe(413);
  expect(await (await get("/api/settings")).json()).toEqual({ theme: "dark" });
  const del = await fetch(`${base}/api/settings`, { method: "DELETE", headers: json });
  expect(del.status).toBe(405);
});

test("/api/external opens only http(s) URLs", async () => {
  const post = (body: string) => fetch(`${base}/api/external`, { method: "POST", headers: json, body });
  expect((await post(JSON.stringify({ url: "https://example.com/x?y=1" }))).status).toBe(200);
  expect(opened).toEqual(["https://example.com/x?y=1"]);
  expect((await post(JSON.stringify({ url: "file:///etc/passwd" }))).status).toBe(400);
  expect((await post(JSON.stringify({ url: "javascript:alert(1)" }))).status).toBe(400);
  expect((await post(JSON.stringify({ url: "not a url" }))).status).toBe(400);
  expect((await post("garbage")).status).toBe(400);
  expect((await post("{}")).status).toBe(400);
  expect(opened.length).toBe(1);
  expect((await get("/api/external")).status).toBe(405);
});

test("/api/open validates the path and broadcasts to event sockets", async () => {
  const post = (body: unknown) => fetch(`${base}/api/open`, { method: "POST", headers: json, body: typeof body === "string" ? body : JSON.stringify(body) });
  expect((await get("/api/open")).status).toBe(405);
  expect((await post("garbage")).status).toBe(400);
  expect((await post({})).status).toBe(400);
  expect((await post({ path: path.join(outside, "secret.txt") })).status).toBe(404);
  expect((await post({ path: "missing.txt" })).status).toBe(404);
  expect((await post({ path: "escape" })).status).toBe(404);

  expect(await (await post({ path: "a.txt" })).json()).toEqual({ ok: true, clients: 0 });
  const ev = await events();
  try {
    expect(await (await post({ path: path.join(dir, "sub", "b.ts"), line: 7 })).json()).toEqual({ ok: true, clients: 1 });
    const m = await ev.waitFor((m) => m.t === "open");
    expect(m).toEqual({ t: "open", path: "sub/b.ts", line: 7 });
    ev.msgs.length = 0;
    await post({ path: "a.txt" });
    expect((await ev.waitFor((m) => m.t === "open")).line).toBe(0);
  } finally {
    ev.ws.close();
  }
});

test("unknown API paths and unknown websocket paths are 404", async () => {
  expect((await get("/api/nope")).status).toBe(404);
  expect((await get("/ws/other")).status).toBe(404);
  expect((await get("/ws/events", {})).status).toBe(401);
});

test("/ws/pty validates the id; /ws/events upgrade over plain HTTP fails", async () => {
  expect((await get(`/ws/pty?id=x&t=${token}`)).status).toBe(400);
  expect((await get(`/ws/pty?id=abcdef123&t=${token}`)).status).toBe(400); // valid id but not an upgrade
  expect((await get(`/ws/events?t=${token}`)).status).toBe(400);
});

test("pty websocket runs a shell with CODEVIEWER_* env and closes cleanly", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?t=${token}&id=term-cov-1&cols=100&rows=30`, { headers: { origin: base } } as never);
  ws.binaryType = "arraybuffer";
  let out = "";
  const dec = new TextDecoder();
  ws.onmessage = (e) => {
    out += typeof e.data === "string" ? e.data : dec.decode(e.data as ArrayBuffer);
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("pty ws failed"));
  });
  ws.send(JSON.stringify({ t: "resize", cols: 120, rows: 40 }));
  ws.send(new TextEncoder().encode('echo "URL=$CODEVIEWER_URL" "TP=$TERM_PROGRAM"\n'));
  const t0 = Date.now();
  while (!out.includes(`URL=${base}`) && Date.now() - t0 < 6000) await Bun.sleep(30);
  expect(out).toContain(`URL=${base}`);
  expect(out).toContain("TP=codeviewer");
  ws.send(JSON.stringify({ t: "kill" }));
  await Bun.sleep(100);
  ws.close();
});

test("file changes are broadcast on the events socket", async () => {
  const ev = await events();
  try {
    await Bun.sleep(200);
    await writeFile(path.join(dir, "new-file.txt"), "hi");
    const m = await ev.waitFor((m) => m.t === "changed" && m.paths.includes("new-file.txt"), 8000);
    expect(m.structural).toBe(true);
    expect((await (await get("/api/index")).text()).split("\n")).toContain("new-file.txt");
  } finally {
    ev.ws.close();
  }
});

test("non-loopback host disables the Host check and rewrites wildcard URLs", async () => {
  const other = startServer({ root: dir, port: 0, host: "0.0.0.0", shell: "/bin/sh", token, openExternal: () => {}, updater: fake as never });
  try {
    expect(other.url).toBe(`http://127.0.0.1:${other.server.port}/#t=${token}`);
    const r = await fetch(`http://127.0.0.1:${other.server.port}/api/info`, { headers: { ...auth, host: "anything.example" } });
    expect(r.status).toBe(200);
  } finally {
    other.stop();
  }
  const v6 = startServer({ root: dir, port: 0, host: "::1", shell: "/bin/sh", token, openExternal: () => {}, updater: fake as never });
  try {
    expect(v6.url).toBe(`http://[::1]:${v6.server.port}/#t=${token}`);
  } finally {
    v6.stop();
  }
});

test("background auto-update check is skipped when disabled via settings", async () => {
  // With the env var unset and updates.auto=false in settings, no check is made and status is the default.
  const prev = process.env.CODEVIEWER_NO_UPDATE_CHECK;
  delete process.env.CODEVIEWER_NO_UPDATE_CHECK;
  await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ updates: { auto: false } }) });
  let checks = 0;
  const counting = { ...fake, check: async () => (checks++, fake.check()) };
  const s = startServer({ root: dir, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {}, updater: counting as never });
  try {
    const j = await (await fetch(`http://127.0.0.1:${s.server.port}/api/update`, { headers: auth })).json();
    expect(j.available).toBe(false);
    expect(checks).toBe(0);
  } finally {
    s.stop();
    if (prev !== undefined) process.env.CODEVIEWER_NO_UPDATE_CHECK = prev;
    else process.env.CODEVIEWER_NO_UPDATE_CHECK = "1";
  }
});

test("a non-git directory reports repo:false and 404s base/blame", async () => {
  const plain = await realpath(await mkdtemp(path.join(tmpdir(), "cv-plain-")));
  await writeFile(path.join(plain, "f.txt"), "x");
  const s = startServer({ root: plain, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {}, updater: fake as never });
  try {
    const b = `http://127.0.0.1:${s.server.port}`;
    expect(await (await fetch(`${b}/api/git/status`, { headers: auth })).json()).toEqual({ repo: false });
    expect((await fetch(`${b}/api/git/base?path=f.txt`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${b}/api/git/blame?path=f.txt&line=1`, { headers: auth })).status).toBe(404);
  } finally {
    s.stop();
    await rm(plain, { recursive: true, force: true });
  }
});

test("background auto-update check runs once per launch and feeds /api/update", async () => {
  const prev = process.env.CODEVIEWER_NO_UPDATE_CHECK;
  delete process.env.CODEVIEWER_NO_UPDATE_CHECK;
  await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: "{}" });
  let checks = 0;
  const counting = { ...fake, check: async () => (checks++, fake.check()) };
  const s = startServer({ root: dir, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {}, updater: counting as never });
  try {
    // The status request waits for the delayed background check.
    const j = await (await fetch(`http://127.0.0.1:${s.server.port}/api/update`, { headers: auth })).json();
    expect(checks).toBe(1);
    expect(j).toMatchObject({ latest: "9.9.9", available: true });
  } finally {
    s.stop();
    process.env.CODEVIEWER_NO_UPDATE_CHECK = prev ?? "1";
  }
}, 10000);

test("/api/raw honours a single byte range (206/416) so media can seek, also under ?limit", async () => {
  const r = (range: string, extra = "") => get(`/api/raw?path=noext${extra}`, { ...auth, range });
  expect((await get("/api/raw?path=noext")).headers.get("accept-ranges")).toBe("bytes");
  const mid = await r("bytes=10-19");
  expect(mid.status).toBe(206);
  expect(mid.headers.get("content-range")).toBe("bytes 10-19/1000");
  expect((await mid.text()).length).toBe(10);
  const tail = await r("bytes=990-");
  expect(tail.status).toBe(206);
  expect(tail.headers.get("content-range")).toBe("bytes 990-999/1000");
  expect((await tail.text()).length).toBe(10);
  const suffix = await r("bytes=-5");
  expect(suffix.headers.get("content-range")).toBe("bytes 995-999/1000");
  expect((await suffix.text()).length).toBe(5);
  const over = await r("bytes=0-5000");
  expect(over.headers.get("content-range")).toBe("bytes 0-999/1000");
  expect((await over.text()).length).toBe(1000);
  const bad = await r("bytes=2000-");
  expect(bad.status).toBe(416);
  expect(bad.headers.get("content-range")).toBe("bytes */1000");
  expect((await r("bytes=20-10")).status).toBe(416);
  // The limit caps the resource the range applies to.
  const lim = await r("bytes=90-200", "&limit=100");
  expect(lim.status).toBe(206);
  expect(lim.headers.get("content-range")).toBe("bytes 90-99/100");
  expect((await lim.text()).length).toBe(10);
  // Unparseable ranges are ignored, not refused.
  expect((await r("bytes=a-b")).status).toBe(200);
  expect((await get("/api/info")).status).toBe(200);
});

test("/api/raw fails the body instead of sending fewer bytes than content-length when the file shrinks", async () => {
  const p = path.join(dir, "shrink.bin");
  await writeFile(p, new Uint8Array(2 * 1024 * 1024));
  const r = await get("/api/raw?path=shrink.bin");
  expect(r.status).toBe(200);
  const reader = r.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  await truncate(p, 10);
  // The transfer fails (the stream is errored): never a quiet success with a truncated body.
  let failed = false;
  try {
    for (let c = await reader.read(); !c.done; c = await reader.read());
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect((await get("/api/info")).status).toBe(200);
});
