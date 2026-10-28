import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VERSION } from "../src/server/http.ts";

// Captured at load: other test files may swap globalThis.fetch/WebSocket for mocks.
const fetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch;
const WebSocket = globalThis.WebSocket;
const MAIN = path.resolve(import.meta.dir, "../src/server/main.ts");
let dir = "";
let cfg = "";

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-main-")));
  cfg = await realpath(await mkdtemp(path.join(tmpdir(), "cv-main-cfg-")));
  await writeFile(path.join(dir, "file.txt"), "x");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(cfg, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CODEVIEWER_")) e[k] = v;
  return { ...e, XDG_CONFIG_HOME: cfg, CODEVIEWER_NO_UPDATE_CHECK: "1", ...extra };
};

async function run(args: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", MAIN, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: env(extra), cwd: dir });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

/** Starts the server and resolves once `ready` matches stdout. */
async function serve(args: string[], ready: RegExp, extra: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", MAIN, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: env(extra), cwd: dir });
  let out = "";
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  const deadline = Date.now() + 15000;
  while (!ready.test(out) && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), Bun.sleep(200).then(() => null)]);
    if (r === null) continue;
    if (r.done) break;
    out += dec.decode(r.value);
  }
  return { p, out, reader };
}

test("--version and -v print the version", async () => {
  for (const f of ["--version", "-v"]) {
    const r = await run([f]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(VERSION);
  }
});

test("--help and -h print usage", async () => {
  for (const f of ["--help", "-h"]) {
    const r = await run([f]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`codeviewer ${VERSION}`);
    expect(r.out).toContain("--no-open");
    expect(r.out).toContain("codeviewer open <file[:line]>");
  }
});

test("unknown option exits 1 with usage on stderr", async () => {
  const r = await run(["--bogus"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("unknown option --bogus");
  expect(r.err).toContain("Usage:");
});

test("options that need a value complain when it is missing", async () => {
  for (const f of ["--port", "-p", "--host", "--shell"]) {
    const r = await run([f]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${f} needs a value`);
  }
});

test("invalid ports are rejected", async () => {
  for (const v of ["abc", "-1", "70000", "1.5"]) {
    const r = await run(["--port", v, "--no-open", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("invalid port");
  }
});

test("missing directories and plain files are rejected", async () => {
  const missing = await run(["--no-open", path.join(dir, "nope")]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("cannot open");
  const file = await run(["--no-open", path.join(dir, "file.txt")]);
  expect(file.code).toBe(1);
  expect(file.err).toContain("is not a directory");
});

test("--machine prints a single JSON line with url and root, and the server answers", async () => {
  const { p, out } = await serve(["--machine", "--no-open", "--shell", "/bin/sh", dir], /\}\s*$/m);
  try {
    const j = JSON.parse(out.trim().split("\n")[0]!);
    expect(j.root).toBe(dir);
    const u = new URL(j.url);
    expect(u.hostname).toBe("127.0.0.1");
    const token = u.hash.replace("#t=", "");
    expect(token.length).toBeGreaterThanOrEqual(43);
    const info = await (await fetch(`${u.origin}/api/info`, { headers: { "x-cv-token": token } })).json();
    expect(info.root).toBe(dir);
    expect(info.shell).toBe("sh");
    expect((await fetch(`${u.origin}/api/info`)).status).toBe(401);
  } finally {
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
  }
});

test("--no-open prints the banner with root and URL; -p picks the port; SIGINT quits cleanly", async () => {
  // Find a free port, release it, and ask main.ts to take it.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  const { p, out } = await serve(["-p", String(port), "--no-open", dir], /Ctrl\+C to quit/);
  try {
    expect(out).toContain("codeviewer");
    expect(out).toContain(dir);
    expect(out).toContain(`http://127.0.0.1:${port}/#t=`);
    expect(out).not.toContain("Listening on");
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  } finally {
    p.kill("SIGINT");
    expect(await p.exited).toBe(0);
  }
});

test("a non-loopback --host prints a warning", async () => {
  const { p, out } = await serve(["--host", "0.0.0.0", "--no-open", dir], /Ctrl\+C to quit/);
  try {
    expect(out).toContain("Listening on 0.0.0.0");
  } finally {
    p.kill("SIGTERM");
    await p.exited;
  }
});

test("--exit-with-parent keeps running while the parent lives", async () => {
  const { p, out } = await serve(["--exit-with-parent", "--machine", "--no-open", dir], /\}\s*$/m);
  try {
    expect(JSON.parse(out.trim().split("\n")[0]!).root).toBe(dir);
    await Bun.sleep(1300);
    expect(p.exitCode).toBeNull();
  } finally {
    p.kill("SIGHUP");
    expect(await p.exited).toBe(0);
  }
});

// --- `codeviewer open` ---

test("open: usage and environment errors", async () => {
  const noArg = await run(["open"]);
  expect(noArg.code).toBe(1);
  expect(noArg.err).toContain("usage: codeviewer open");
  const noEnv = await run(["open", "file.txt"]);
  expect(noEnv.code).toBe(1);
  expect(noEnv.err).toContain("not inside a codeviewer terminal");
  const unreachable = await run(["open", "file.txt"], { CODEVIEWER_URL: "http://127.0.0.1:1", CODEVIEWER_TOKEN: "t" });
  expect(unreachable.code).toBe(1);
  expect(unreachable.err).toContain("cannot reach viewer");
});

test("open: posts the resolved absolute path and line with the token", async () => {
  const seen: { path: string; body: any; token: string | null }[] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const body = await req.json();
      seen.push({ path: u.pathname, body, token: req.headers.get("x-cv-token") });
      if (body.path.endsWith("denied.txt")) return Response.json({ error: "path is outside the viewed directory" }, { status: 404 });
      if (body.path.endsWith("broken.txt")) return new Response("nope", { status: 500, statusText: "Server Error" });
      return Response.json({ ok: true });
    },
  });
  try {
    const envv = { CODEVIEWER_URL: `http://127.0.0.1:${srv.port}`, CODEVIEWER_TOKEN: "tok" };
    const ok = await run(["open", "file.txt:42:7"], envv);
    expect(ok.code).toBe(0);
    expect(seen[0]).toEqual({ path: "/api/open", body: { path: path.join(dir, "file.txt"), line: 42 }, token: "tok" });

    const noLine = await run(["open", "file.txt"], envv);
    expect(noLine.code).toBe(0);
    expect(seen[1]!.body).toEqual({ path: path.join(dir, "file.txt"), line: 0 });

    const abs = await run(["open", `${path.join(dir, "file.txt")}:3`], envv);
    expect(abs.code).toBe(0);
    expect(seen[2]!.body).toEqual({ path: path.join(dir, "file.txt"), line: 3 });

    const denied = await run(["open", "denied.txt"], envv);
    expect(denied.code).toBe(1);
    expect(denied.err).toContain("path is outside the viewed directory");

    const broken = await run(["open", "broken.txt"], envv);
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("Server Error");
  } finally {
    srv.stop(true);
  }
});

test("open: end-to-end against a real codeviewer server", async () => {
  const { p, out } = await serve(["--machine", "--no-open", dir], /\}\s*$/m);
  try {
    const u = new URL(JSON.parse(out.trim().split("\n")[0]!).url);
    const token = u.hash.replace("#t=", "");
    const ok = await run(["open", "file.txt:5"], { CODEVIEWER_URL: u.origin, CODEVIEWER_TOKEN: token });
    expect(ok.code).toBe(0);
    const bad = await run(["open", "/etc/hosts"], { CODEVIEWER_URL: u.origin, CODEVIEWER_TOKEN: token });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("outside the viewed directory");
  } finally {
    p.kill("SIGTERM");
    await p.exited;
  }
});

// --- in-process runs (so the module is attributed in coverage reports) ---

class Exit extends Error {
  constructor(public code: number | undefined) {
    super(`exit ${code}`);
  }
}

/** Imports a fresh copy of main.ts with the given argv, capturing console output and exit. */
async function inProcess(args: string[], envv: Record<string, string> = {}) {
  const origArgv = process.argv;
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  const saved: Record<string, string | undefined> = {};
  const out: string[] = [];
  const err: string[] = [];
  let exit: number | undefined;
  process.argv = [origArgv[0]!, MAIN, ...args];
  (process as any).exit = (c?: number) => {
    throw new Exit(c);
  };
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  for (const [k, v] of Object.entries(envv)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    await import(`${MAIN}?run=${Math.random()}`);
  } catch (e) {
    if (e instanceof Exit) exit = e.code;
    else throw e;
  } finally {
    process.argv = origArgv;
    (process as any).exit = origExit;
    console.log = origLog;
    console.error = origErr;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { out: out.join("\n"), err: err.join("\n"), exit };
}

test("in-process: version, help, and argument errors", async () => {
  expect((await inProcess(["--version"])).out).toBe(VERSION);
  expect((await inProcess(["-h"])).out).toContain("Usage:");
  const bad = await inProcess(["--nope"]);
  expect(bad.exit).toBe(1);
  expect(bad.err).toContain("unknown option --nope");
  expect((await inProcess(["--port"])).err).toContain("--port needs a value");
  expect((await inProcess(["--port", "99999", dir])).err).toContain("invalid port");
  expect((await inProcess(["--no-open", path.join(dir, "missing")])).err).toContain("cannot open");
  expect((await inProcess(["--no-open", path.join(dir, "file.txt")])).err).toContain("is not a directory");
  expect((await inProcess(["open"])).err).toContain("usage: codeviewer open");
  expect((await inProcess(["open", "x"], { CODEVIEWER_URL: "", CODEVIEWER_TOKEN: "" })).err).toContain("not inside a codeviewer terminal");
});

test("in-process: open posts to the viewer", async () => {
  let body: any;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { body = await req.json(); return Response.json({ ok: true }); } });
  try {
    const r = await inProcess(["open", "file.txt:9"], { CODEVIEWER_URL: `http://127.0.0.1:${srv.port}`, CODEVIEWER_TOKEN: "t" });
    expect(r.exit).toBeUndefined();
    expect(body).toEqual({ path: path.join(process.cwd(), "file.txt"), line: 9 });
    const down = await inProcess(["open", "f"], { CODEVIEWER_URL: "http://127.0.0.1:1", CODEVIEWER_TOKEN: "t" });
    expect(down.exit).toBe(1);
    expect(down.err).toContain("cannot reach viewer");
  } finally {
    srv.stop(true);
  }
});

test("in-process: server start-up paths (machine JSON, banner, host warning, SIGTERM quits)", async () => {
  const sigs = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const before = Object.fromEntries(sigs.map((s) => [s, new Set(process.listeners(s))]));
  const stopAll = () => {
    const realExit = process.exit;
    (process as any).exit = (c?: number) => {
      throw new Exit(c);
    };
    try {
      stopListeners();
    } finally {
      (process as any).exit = realExit;
    }
  };
  const stopListeners = () => {
    for (const s of sigs) {
      for (const l of process.listeners(s)) if (!before[s]!.has(l as never)) {
        try {
          (l as () => void)();
        } catch (e) {
          if (!(e instanceof Exit)) throw e;
        }
        process.off(s, l as never);
      }
    }
  };
  const savedEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({ XDG_CONFIG_HOME: cfg, CODEVIEWER_NO_UPDATE_CHECK: "1" })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const m = await inProcess(["--machine", "--no-open", "--exit-with-parent", "--shell", "/bin/sh", dir]);
    const j = JSON.parse(m.out);
    expect(j.root).toBe(dir);
    expect((await fetch(`${new URL(j.url).origin}/`)).status).toBe(200);
    stopAll();
    await Bun.sleep(50);
    await expect(fetch(`${new URL(j.url).origin}/`)).rejects.toBeDefined();

    const b = await inProcess(["--no-open", "--host", "0.0.0.0", dir]);
    expect(b.out).toContain("Listening on 0.0.0.0");
    expect(b.out).toContain("Press Ctrl+C to quit.");
    expect(b.out).toContain(dir);
    stopAll();
  } finally {
    stopAll();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
