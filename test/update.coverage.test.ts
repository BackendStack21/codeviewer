import { afterEach, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareVersions, detectInstall, importPublicKey, parseSums, Updater, verifySignature, UPDATE_PUBLIC_KEY, type Install } from "../src/server/update.ts";

let keyPem = "";
let privateKey: CryptoKey;
const dirs: string[] = [];

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = kp.privateKey;
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", kp.publicKey)).toString("base64");
  keyPem = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----\n`;
});
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), "cv-updc-")));
  dirs.push(d);
  return d;
}
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

interface Rel {
  tag?: string;
  draft?: boolean;
  prerelease?: boolean;
  files?: Record<string, Uint8Array>;
  sums?: string;
  sign?: boolean;
  b64sig?: boolean;
  status?: number;
  omit?: string[];
  noLength?: boolean;
  failDownload?: boolean;
}

function fake(r: Rel) {
  const files: Record<string, Uint8Array> = { ...(r.files ?? {}) };
  const sumsBytes = enc(r.sums ?? Object.entries(files).map(([n, b]) => `${sha(b)}  ${n}`).join("\n") + "\n");
  files["SHA256SUMS"] = sumsBytes;
  let sigP: Promise<Uint8Array> | null = null;
  const sig = () =>
    (sigP ??= crypto.subtle.sign("Ed25519", privateKey, sumsBytes).then((s) => (r.b64sig ? enc(Buffer.from(s).toString("base64") + "\n") : new Uint8Array(s))));
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/releases/latest")) {
      if (r.status) return new Response("err", { status: r.status });
      const names = [...Object.keys(files), ...(r.sign === false ? [] : ["SHA256SUMS.sig"])].filter((n) => !(r.omit ?? []).includes(n));
      return Response.json({
        tag_name: r.tag ?? "v1.1.0",
        draft: r.draft,
        prerelease: r.prerelease,
        body: "n".repeat(5000),
        assets: names.map((name) => ({ name, browser_download_url: "https://example.test/dl/" + name })),
      });
    }
    const name = url.slice("https://example.test/dl/".length);
    if (r.failDownload && name !== "SHA256SUMS" && name !== "SHA256SUMS.sig") return new Response("x", { status: 500 });
    const body = name === "SHA256SUMS.sig" ? await sig() : files[name];
    if (!body) return new Response("nope", { status: 404 });
    return new Response(body as BodyInit, r.noLength ? {} : { headers: { "content-length": String(body.length) } });
  }) as typeof fetch;
  return { f, calls };
}

async function cli(r: Rel, version = "1.0.0") {
  const dir = await tmp();
  const target = path.join(dir, "codeviewer");
  await writeFile(target, "old");
  await chmod(target, 0o755);
  const install: Install = { kind: "cli", target, asset: (v) => `codeviewer-${v}-linux-x64` };
  const g = fake({ files: { "codeviewer-1.1.0-linux-x64": enc("new") }, ...r });
  return { dir, target, calls: g.calls, u: new Updater({ version, fetch: g.f, publicKey: keyPem, install }) };
}

test("compareVersions: pre-release ordering and padding", () => {
  expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
  expect(compareVersions("1.0.0-beta", "1.0.0-alpha")).toBe(1);
  expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  expect(compareVersions("1.0.0-rc", "1.0.0-rc")).toBe(0);
  expect(compareVersions("1.2", "1.2.0")).toBe(0);
});

test("detectInstall: bun is 'source'; unknown linux/mac binaries are 'cli'", () => {
  expect(detectInstall("/usr/bin/bun", "linux", "x64", () => false).kind).toBe("source");
  expect(detectInstall("/x/codeviewer", "linux", "arm64", () => false).asset("1.0.0")).toBe("codeviewer-1.0.0-linux-arm64");
  // default arguments resolve to something sensible for the running process
  expect(["source", "cli", "macos-app", "linux-app"]).toContain(detectInstall().kind);
});

test("the compiled-in release key is a usable Ed25519 public key", async () => {
  expect(UPDATE_PUBLIC_KEY).toContain("BEGIN PUBLIC KEY");
  expect(await importPublicKey(UPDATE_PUBLIC_KEY)).not.toBeNull();
});

test("importPublicKey / verifySignature reject garbage", async () => {
  expect(await importPublicKey("not a key")).toBeNull();
  expect(await importPublicKey("-----BEGIN PUBLIC KEY-----\n@@@\n-----END PUBLIC KEY-----")).toBeNull();
  const data = enc("hello");
  expect(await verifySignature("junk", data, new Uint8Array(64))).toBe(false);
  expect(await verifySignature(keyPem, data, enc("%%% not base64 %%%"))).toBe(false);
  expect(await verifySignature(keyPem, data, enc("AAAA"))).toBe(false); // decodes to wrong length
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, data));
  expect(await verifySignature(keyPem, data, sig)).toBe(true);
  expect(await verifySignature(keyPem, enc("tampered"), sig)).toBe(false);
  expect(await verifySignature(keyPem, data, enc(Buffer.from(sig).toString("base64")))).toBe(true);
});

test("parseSums accepts binary-mode '*' names and ignores junk lines", () => {
  const h = "b".repeat(64);
  const m = parseSums(`${h} *bin file.tgz\nnonsense\n${"z".repeat(64)}  bad\n`);
  expect(m.get("bin file.tgz")).toBe(h);
  expect(m.size).toBe(1);
});

test("check: HTTP errors throw; bad/draft/prerelease tags report no update", async () => {
  await expect((await cli({ status: 503 })).u.check(true)).rejects.toThrow("503");
  for (const r of [{ tag: "nightly" }, { draft: true }, { prerelease: true }] as Rel[]) {
    const info = await (await cli(r)).u.check(true);
    expect(info).toMatchObject({ latest: null, available: false, canInstall: false });
  }
});

test("check: caches for an hour unless forced; notes are truncated", async () => {
  const { u, calls } = await cli({});
  const a = await u.check();
  const b = await u.check();
  expect(b).toBe(a);
  expect(calls.filter((c) => c.endsWith("/latest")).length).toBe(1);
  await u.check(true);
  expect(calls.filter((c) => c.endsWith("/latest")).length).toBe(2);
  expect(a.notes!.length).toBe(4000);
  expect(a.url).toBeUndefined; // html_url absent in fake: falls back to the repo's releases page
  expect(a.url).toContain("github.com");
});

test("check: older or equal release is not available", async () => {
  const info = await (await cli({}, "1.1.0")).u.check(true);
  expect(info).toMatchObject({ latest: "1.1.0", available: false });
  await expect((await cli({}, "1.1.0")).u.apply()).rejects.toThrow("already up to date");
});

test("check: explains why an update cannot be installed", async () => {
  // no asset for this platform
  let c = await cli({ files: { "other-1.1.0": enc("x") } });
  expect((await c.u.check(true)).reason).toContain("no build for your platform");
  // unsigned
  c = await cli({ sign: false });
  expect((await c.u.check(true)).reason).toContain("isn't signed");
  // placeholder key
  const g = fake({ files: { "codeviewer-1.1.0-linux-x64": enc("new") } });
  const dir = await tmp();
  const install: Install = { kind: "cli", target: path.join(dir, "cv"), asset: (v) => `codeviewer-${v}-linux-x64` };
  expect((await new Updater({ version: "1.0.0", fetch: g.f, publicKey: "# none", install }).check(true)).reason).toContain("no update signing key");
  // unwritable / missing target directory
  const bad: Install = { kind: "cli", target: path.join(dir, "missing", "cv"), asset: install.asset };
  const info = await new Updater({ version: "1.0.0", fetch: g.f, publicKey: keyPem, install: bad }).check(true);
  expect(info).toMatchObject({ available: true, canInstall: false });
  expect(info.reason).toContain("No permission");
  // source installs
  const src = await new Updater({ version: "1.0.0", fetch: g.f, publicKey: keyPem, install: { kind: "source", target: "", asset: () => "" } }).check(true);
  expect(src.reason).toContain("git pull");
});

test("apply refuses when it cannot install, with the reason", async () => {
  await expect((await cli({ sign: false })).u.apply()).rejects.toThrow("isn't signed");
});

test("apply accepts a base64 signature and works without content-length", async () => {
  const { u, target } = await cli({ b64sig: true, noLength: true });
  const details: string[] = [];
  const res = await u.apply((p, d) => p === "download" && details.push(d!));
  expect(res).toMatchObject({ version: "1.1.0", kind: "cli", target });
  expect(await readFile(target, "utf8")).toBe("new");
  expect(details).toEqual(["0%"]);
  expect(u.installing).toBe(false);
});

test("apply reports download percentage with content-length", async () => {
  const { u } = await cli({});
  const details: string[] = [];
  await u.apply((p, d) => p === "download" && details.push(d!));
  expect(details.at(-1)).toBe("100%");
});

test("apply rejects an asset missing from the signed list, and leaves the old binary", async () => {
  const { u, target, dir } = await cli({ sums: `${"a".repeat(64)}  something-else\n` });
  await expect(u.apply()).rejects.toThrow("not in the signed checksum list");
  expect(await readFile(target, "utf8")).toBe("old");
  expect((await Bun.file(path.join(dir, "codeviewer")).exists())).toBe(true);
});

test("apply rejects a signed file name that doesn't carry the release version", async () => {
  const dir = await tmp();
  const target = path.join(dir, "cv");
  await writeFile(target, "old");
  const g = fake({ files: { "codeviewer-linux-x64": enc("new") } });
  // asset name has no version in it: a mix-up/rollback attempt
  const install: Install = { kind: "cli", target, asset: () => "codeviewer-linux-x64" };
  await expect(new Updater({ version: "1.0.0", fetch: g.f, publicKey: keyPem, install }).apply()).rejects.toThrow("doesn't match the release version");
  expect(await readFile(target, "utf8")).toBe("old");
});

test("apply fails cleanly when the download fails, and cleans its staging dir", async () => {
  const { u, dir, target } = await cli({ failDownload: true });
  await expect(u.apply()).rejects.toThrow("download failed (500)");
  expect(await readFile(target, "utf8")).toBe("old");
  const left = (await Array.fromAsync(new Bun.Glob(".codeviewer-update-*").scan({ cwd: dir, onlyFiles: false })));
  expect(left).toEqual([]);
  expect(u.installing).toBe(false); // not stuck busy
});

test("apply fails when SHA256SUMS can't be fetched", async () => {
  const dir = await tmp();
  const target = path.join(dir, "cv");
  const g = fake({ files: { "codeviewer-1.1.0-linux-x64": enc("new") } });
  const wrapped = (async (u: string | URL | Request, i?: RequestInit) =>
    String(u).endsWith("/SHA256SUMS") ? new Response("", { status: 404 }) : g.f(u, i)) as typeof fetch;
  const install: Install = { kind: "cli", target, asset: (v) => `codeviewer-${v}-linux-x64` };
  await expect(new Updater({ version: "1.0.0", fetch: wrapped, publicKey: keyPem, install }).apply()).rejects.toThrow("download failed (404)");
});

test("apply refuses to run concurrently", async () => {
  const { u } = await cli({});
  const first = u.apply();
  expect(u.installing).toBe(true);
  await expect(u.apply()).rejects.toThrow("already being installed");
  await first;
});

test("linux package: bad layout is rejected and the install is untouched; good layout swaps", async () => {
  const dir = await tmp();
  const target = path.join(dir, "app");
  await mkdir(target);
  await writeFile(path.join(target, "codeviewer"), "old");
  const install: Install = { kind: "linux-app", target, asset: (v) => `codeviewer-${v}-linux-x64.tar.gz` };
  const pack = async (withChrome: boolean) => {
    const src = await tmp();
    const pkg = path.join(src, "codeviewer-1.1.0");
    await mkdir(path.join(pkg, "chromium"), { recursive: true });
    await writeFile(path.join(pkg, "codeviewer"), "new");
    if (withChrome) await writeFile(path.join(pkg, "chromium", "chrome"), "c");
    const tgz = path.join(src, "p.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", tgz, "-C", src, "codeviewer-1.1.0"]).exitCode).toBe(0);
    return new Uint8Array(await Bun.file(tgz).arrayBuffer());
  };
  const name = "codeviewer-1.1.0-linux-x64.tar.gz";
  let g = fake({ files: { [name]: await pack(false) } });
  await expect(new Updater({ version: "1.0.0", fetch: g.f, publicKey: keyPem, install }).apply()).rejects.toThrow("unexpected package layout");
  expect(await readFile(path.join(target, "codeviewer"), "utf8")).toBe("old");
  g = fake({ files: { [name]: await pack(true) } });
  await new Updater({ version: "1.0.0", fetch: g.f, publicKey: keyPem, install }).apply();
  expect(await readFile(path.join(target, "codeviewer"), "utf8")).toBe("new");
});

test("linux package: a corrupt archive fails with the tool's message", async () => {
  const dir = await tmp();
  const target = path.join(dir, "app");
  await mkdir(target);
  const name = "codeviewer-1.1.0-linux-x64.tar.gz";
  const install: Install = { kind: "linux-app", target, asset: (v) => `codeviewer-${v}-linux-x64.tar.gz` };
  const g = fake({ files: { [name]: enc("not a tarball") } });
  await expect(new Updater({ version: "1.0.0", fetch: g.f, publicKey: keyPem, install }).apply()).rejects.toThrow(/tar failed/);
});
