import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareVersions, detectInstall, parseSums, Updater, verifySignature, type Install } from "../src/server/update.ts";

// A fake GitHub: the releases API plus downloadable assets, served from memory.
let keyPem = "";
let privateKey: CryptoKey;
let otherKey: CryptoKey;
const dirs: string[] = [];

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = kp.privateKey;
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", kp.publicKey)).toString("base64");
  keyPem = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----\n`;
  otherKey = ((await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;
});

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp() {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), "cv-upd-")));
  dirs.push(d);
  return d;
}

const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

interface FakeRelease {
  version: string;
  files: Record<string, Uint8Array>;
  /** Overrides for tampering tests */
  sumsOverride?: string;
  signWith?: CryptoKey | null;
}

async function fakeGitHub(r: FakeRelease) {
  const files = { ...r.files };
  const sums = r.sumsOverride ?? Object.entries(files).map(([n, b]) => `${sha(b)}  ${n}`).join("\n") + "\n";
  const sumsBytes = new TextEncoder().encode(sums);
  files["SHA256SUMS"] = sumsBytes;
  const signer = r.signWith === undefined ? privateKey : r.signWith;
  if (signer) files["SHA256SUMS.sig"] = new Uint8Array(await crypto.subtle.sign("Ed25519", signer, sumsBytes));
  const base = "https://example.test/dl/";
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/releases/latest")) {
      return Response.json({
        tag_name: `v${r.version}`,
        html_url: "https://example.test/release",
        body: "Notes",
        assets: Object.keys(files).map((name) => ({ name, browser_download_url: base + name })),
      });
    }
    const name = url.slice(base.length);
    const body = files[name];
    return body ? new Response(body as BodyInit, { headers: { "content-length": String(body.length) } }) : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return fetchFn;
}

describe("versions and install detection", () => {
  test("compareVersions", () => {
    expect(compareVersions("1.1.0", "1.0.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.10")).toBe(-1);
    expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });

  test("detectInstall maps executables to the right release asset", () => {
    const mac = detectInstall("/Applications/Codeviewer.app/Contents/Resources/codeviewer", "darwin", "arm64", () => false);
    expect(mac.kind).toBe("macos-app");
    expect(mac.target).toBe("/Applications/Codeviewer.app");
    expect(mac.asset("1.2.0")).toBe("Codeviewer-1.2.0-macos-arm64.dmg");

    const linux = detectInstall("/opt/codeviewer/codeviewer", "linux", "x64", (p) => p === "/opt/codeviewer/chromium/chrome");
    expect(linux.kind).toBe("linux-app");
    expect(linux.target).toBe("/opt/codeviewer");
    expect(linux.asset("1.2.0")).toBe("codeviewer-1.2.0-linux-x64.tar.gz");

    const cli = detectInstall("/usr/local/bin/codeviewer", "linux", "x64", (p) => p === "/lib/ld-musl-x86_64.so.1");
    expect(cli.kind).toBe("cli");
    expect(cli.asset("1.2.0")).toBe("codeviewer-1.2.0-linux-x64-musl");

    expect(detectInstall("/Users/me/.bun/bin/bun", "darwin", "arm64").kind).toBe("source");
  });

  test("signature verification", async () => {
    const data = new TextEncoder().encode("abc");
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, data));
    expect(await verifySignature(keyPem, data, sig)).toBe(true);
    expect(await verifySignature(keyPem, new TextEncoder().encode("abd"), sig)).toBe(false);
    expect(await verifySignature("not a key", data, sig)).toBe(false);
    expect(parseSums(`${"a".repeat(64)}  x.dmg\n`).get("x.dmg")).toBe("a".repeat(64));
  });
});

describe("CLI binary updates", () => {
  async function setup(release: Partial<FakeRelease> & { version?: string } = {}) {
    const dir = await tmp();
    const target = path.join(dir, "codeviewer");
    await writeFile(target, "old binary");
    await chmod(target, 0o755);
    const install: Install = { kind: "cli", target, asset: (v) => `codeviewer-${v}-linux-x64` };
    const version = release.version ?? "1.1.0";
    const fetchFn = await fakeGitHub({ version, files: { [`codeviewer-${version}-linux-x64`]: new TextEncoder().encode("new binary") }, ...release });
    return { dir, target, updater: new Updater({ version: "1.0.0", fetch: fetchFn, assetHosts: ["example.test"], publicKey: keyPem, install }) };
  }

  test("installs a verified update, reporting every phase", async () => {
    const { target, dir, updater } = await setup();
    const info = await updater.check(true);
    expect(info).toMatchObject({ current: "1.0.0", latest: "1.1.0", available: true, canInstall: true, kind: "cli" });
    const phases: string[] = [];
    await updater.apply((p) => phases.push(p));
    expect(await readFile(target, "utf8")).toBe("new binary");
    expect((await stat(target)).mode & 0o111).toBeTruthy();
    expect([...new Set(phases)]).toEqual(["signature", "download", "checksum", "install", "done"]);
    expect((await readdir(dir)).filter((n) => n.startsWith(".codeviewer-update"))).toEqual([]);
  });

  test("downloads only from the release hosts, over https", async () => {
    const dir = await tmp();
    const target = path.join(dir, "codeviewer");
    await writeFile(target, "old binary");
    const install: Install = { kind: "cli", target, asset: (v) => `codeviewer-${v}-linux-x64` };
    const fetchFn = await fakeGitHub({ version: "1.1.0", files: { "codeviewer-1.1.0-linux-x64": new TextEncoder().encode("new binary") } });
    // The API answer names assets on example.test; by default only GitHub's hosts are trusted.
    const u = new Updater({ version: "1.0.0", fetch: fetchFn, publicKey: keyPem, install });
    await expect(u.apply()).rejects.toThrow(/refusing to download from example.test/);
    expect(await readFile(target, "utf8")).toBe("old binary");
  });

  test("rejects a checksum list signed by another key", async () => {
    const { target, updater } = await setup({ signWith: otherKey });
    await expect(updater.apply()).rejects.toThrow(/signature is invalid/);
    expect(await readFile(target, "utf8")).toBe("old binary");
  });

  test("rejects a download that doesn't match the signed checksum", async () => {
    const { target, dir, updater } = await setup({
      sumsOverride: `${"0".repeat(64)}  codeviewer-1.1.0-linux-x64\n`,
    });
    await expect(updater.apply()).rejects.toThrow(/checksum mismatch/);
    expect(await readFile(target, "utf8")).toBe("old binary");
    expect((await readdir(dir)).filter((n) => n.startsWith(".codeviewer-update"))).toEqual([]);
  });

  test("never installs an older or equal version", async () => {
    const { target, updater } = await setup({ version: "0.9.0" });
    expect((await updater.check(true)).available).toBe(false);
    await expect(updater.apply()).rejects.toThrow(/up to date/);
    expect(await readFile(target, "utf8")).toBe("old binary");
  });

  test("an unsigned release is reported, not installed", async () => {
    const { updater } = await setup({ signWith: null });
    const info = await updater.check(true);
    expect(info.canInstall).toBe(false);
    expect(info.reason).toMatch(/isn't signed/);
  });

  test("a build without a signing key refuses to install", async () => {
    const { target } = await setup();
    const install: Install = { kind: "cli", target, asset: (v) => `codeviewer-${v}-linux-x64` };
    const fetchFn = await fakeGitHub({ version: "1.1.0", files: { "codeviewer-1.1.0-linux-x64": new Uint8Array([1]) } });
    const u = new Updater({ version: "1.0.0", fetch: fetchFn, assetHosts: ["example.test"], publicKey: "# placeholder", install });
    expect((await u.check(true)).reason).toMatch(/no update signing key/);
  });

  test("running from source is never auto-updated", async () => {
    const fetchFn = await fakeGitHub({ version: "1.1.0", files: {} });
    const u = new Updater({ version: "1.0.0", fetch: fetchFn, assetHosts: ["example.test"], publicKey: keyPem, install: { kind: "source", target: "", asset: () => "" } });
    expect((await u.check(true)).reason).toMatch(/git pull/);
  });
});

describe("Linux package updates", () => {
  test("swaps the whole package directory", async () => {
    const dir = await tmp();
    const target = path.join(dir, "codeviewer");
    await mkdir(path.join(target, "chromium"), { recursive: true });
    await writeFile(path.join(target, "codeviewer"), "old");
    await writeFile(path.join(target, "chromium", "chrome"), "old chrome");

    const src = await tmp();
    await mkdir(path.join(src, "codeviewer", "chromium"), { recursive: true });
    await writeFile(path.join(src, "codeviewer", "codeviewer"), "new");
    await writeFile(path.join(src, "codeviewer", "chromium", "chrome"), "new chrome");
    const tgz = path.join(src, "pkg.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", tgz, "-C", src, "codeviewer"]).exitCode).toBe(0);

    const install: Install = { kind: "linux-app", target, asset: (v) => `codeviewer-${v}-linux-x64.tar.gz` };
    const fetchFn = await fakeGitHub({ version: "1.1.0", files: { "codeviewer-1.1.0-linux-x64.tar.gz": new Uint8Array(await Bun.file(tgz).arrayBuffer()) } });
    await new Updater({ version: "1.0.0", fetch: fetchFn, assetHosts: ["example.test"], publicKey: keyPem, install }).apply();
    expect(await readFile(path.join(target, "codeviewer"), "utf8")).toBe("new");
    expect(await readFile(path.join(target, "chromium", "chrome"), "utf8")).toBe("new chrome");
  });
});

describe.if(process.platform === "darwin")("macOS app updates", () => {
  /** A minimal ad-hoc-signed Codeviewer.app inside a DMG. */
  async function makeDmg(label: string, tamper = false) {
    const src = await tmp();
    const app = path.join(src, "Codeviewer.app");
    await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
    await writeFile(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Codeviewer</string><key>CFBundleIdentifier</key><string>test.codeviewer</string></dict></plist>`);
    await writeFile(path.join(app, "Contents", "MacOS", "Codeviewer"), `#!/bin/sh\necho ${label}\n`);
    await chmod(path.join(app, "Contents", "MacOS", "Codeviewer"), 0o755);
    expect(Bun.spawnSync(["codesign", "--force", "--sign", "-", app]).exitCode).toBe(0);
    if (tamper) await writeFile(path.join(app, "Contents", "MacOS", "Codeviewer"), "#!/bin/sh\necho evil\n");
    const dmg = path.join(src, "app.dmg");
    expect(Bun.spawnSync(["hdiutil", "create", "-quiet", "-volname", "CV", "-srcfolder", app, "-format", "UDZO", dmg]).exitCode).toBe(0);
    return new Uint8Array(await Bun.file(dmg).arrayBuffer());
  }

  async function installed(label: string) {
    const dir = await tmp();
    const target = path.join(dir, "Codeviewer.app");
    await mkdir(path.join(target, "Contents", "MacOS"), { recursive: true });
    await writeFile(path.join(target, "Contents", "MacOS", "Codeviewer"), label);
    return target;
  }

  test("replaces the app bundle with the verified, code-signed one from the DMG", async () => {
    const target = await installed("old");
    const install: Install = { kind: "macos-app", target, asset: (v) => `Codeviewer-${v}-macos-arm64.dmg` };
    const fetchFn = await fakeGitHub({ version: "1.1.0", files: { "Codeviewer-1.1.0-macos-arm64.dmg": await makeDmg("new") } });
    await new Updater({ version: "1.0.0", fetch: fetchFn, assetHosts: ["example.test"], publicKey: keyPem, install }).apply();
    expect(await readFile(path.join(target, "Contents", "MacOS", "Codeviewer"), "utf8")).toContain("echo new");
  }, 60_000);

  test("refuses an app whose code signature doesn't verify, keeping the installed one", async () => {
    const target = await installed("old");
    const install: Install = { kind: "macos-app", target, asset: (v) => `Codeviewer-${v}-macos-arm64.dmg` };
    const fetchFn = await fakeGitHub({ version: "1.1.0", files: { "Codeviewer-1.1.0-macos-arm64.dmg": await makeDmg("new", true) } });
    await expect(new Updater({ version: "1.0.0", fetch: fetchFn, assetHosts: ["example.test"], publicKey: keyPem, install }).apply()).rejects.toThrow(/codesign/);
    expect(await readFile(path.join(target, "Contents", "MacOS", "Codeviewer"), "utf8")).toBe("old");
  }, 60_000);
});
