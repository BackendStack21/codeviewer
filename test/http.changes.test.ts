import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "../src/server/http.ts";

// Captured at load: other test files may swap globalThis.fetch for mocks.
const fetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch;
const token = "D".repeat(43);
const auth = { "x-cv-token": token };

let dir = "";
let plain = "";
let cfg = "";
let app: ReturnType<typeof startServer>;
let app2: ReturnType<typeof startServer>;
let base = "";
let base2 = "";
let mainOid = "";
const saved: Record<string, string | undefined> = {};

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const get = (b: string, p: string) => fetch(`${b}${p}`, { headers: auth });

beforeAll(async () => {
  for (const k of ["XDG_CONFIG_HOME", "CODEVIEWER_NO_UPDATE_CHECK"]) saved[k] = process.env[k];
  cfg = await realpath(await mkdtemp(path.join(tmpdir(), "cv-cfg-")));
  process.env.XDG_CONFIG_HOME = cfg;
  process.env.CODEVIEWER_NO_UPDATE_CHECK = "1";
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-httpch-")));
  plain = await realpath(await mkdtemp(path.join(tmpdir(), "cv-httpplain-")));
  await writeFile(path.join(plain, "f.txt"), "f\n");
  await mkdir(path.join(dir, "sub"));
  await writeFile(path.join(dir, "a.txt"), "line1\nline2\nline3\n");
  await writeFile(path.join(dir, "gone.txt"), "bye\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  mainOid = git("rev-parse", "HEAD");
  git("checkout", "-qb", "topic");
  await writeFile(path.join(dir, "a.txt"), "line1\nCHANGED\nline3\n");
  git("rm", "-q", "gone.txt");
  git("commit", "-qam", "topic work");
  await writeFile(path.join(dir, "sub", "new.ts"), "export const n = 1;\n");
  app = startServer({ root: dir, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {} });
  app2 = startServer({ root: plain, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {} });
  base = app.url.split("/#")[0]!;
  base2 = app2.url.split("/#")[0]!;
});
afterAll(async () => {
  app.stop();
  app2.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
  await rm(plain, { recursive: true, force: true });
  await rm(cfg, { recursive: true, force: true });
});

test("/api/git/changes lists the branch's changes (default) or only uncommitted ones", async () => {
  const r = await get(base, "/api/git/changes");
  expect(r.status).toBe(200);
  const c = (await r.json()) as { repo: boolean; scope: string; rev: string; base: { name: string; same: boolean }; files: { path: string; status: string }[]; commits: number };
  expect(c.repo).toBe(true);
  expect(c.scope).toBe("branch");
  expect(c.base).toMatchObject({ name: "main", same: false });
  expect(c.rev).toBe(mainOid);
  expect(c.commits).toBe(1);
  expect(c.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(["? sub/new.ts", "D gone.txt", "M a.txt"]);

  const h = (await (await get(base, "/api/git/changes?scope=head")).json()) as typeof c;
  expect(h.scope).toBe("head");
  expect(h.files.map((f) => `${f.status} ${f.path}`)).toEqual(["? sub/new.ts"]);
  expect((await (await get(base, "/api/git/changes?scope=bogus")).json()).scope).toBe("branch");
  expect(await (await get(base2, "/api/git/changes")).json()).toEqual({ repo: false });
  expect((await fetch(`${base}/api/git/changes`)).status).toBe(401);
});

test("/api/git/base?rev= reads the old side by object id, including files gone from disk", async () => {
  const a = await get(base, `/api/git/base?path=a.txt&rev=${mainOid}`);
  expect(a.status).toBe(200);
  expect(await a.text()).toBe("line1\nline2\nline3\n");
  const gone = await get(base, `/api/git/base?path=gone.txt&rev=${mainOid}`);
  expect(gone.status).toBe(200);
  expect(await gone.text()).toBe("bye\n");
  expect((await get(base, "/api/git/base?path=gone.txt")).status).toBe(404); // without rev the file must exist
  expect((await get(base, `/api/git/base?path=sub/new.ts&rev=${mainOid}`)).status).toBe(404);
});

test("/api/git/base rejects anything but a full object id and malformed paths", async () => {
  for (const rev of ["main", "HEAD", "main..HEAD", "-" + "a".repeat(39), "a".repeat(39), "%00", "--output=x"]) {
    expect((await get(base, `/api/git/base?path=a.txt&rev=${encodeURIComponent(rev)}`)).status).toBe(400);
  }
  for (const p of ["../a.txt", "/etc/passwd", "a/../../x", "", "C:\\x", "a%00b"]) {
    expect((await get(base, `/api/git/base?path=${encodeURIComponent(p)}&rev=${mainOid}`)).status).toBe(404);
  }
  expect((await get(base2, `/api/git/base?path=f.txt&rev=${mainOid}`)).status).toBe(404);
});
