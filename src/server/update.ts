import { access, chmod, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { constants, existsSync, realpathSync } from "node:fs";
import path from "node:path";
// The release-signing public key (PEM, Ed25519), compiled into the binary.
import updateKeyPem from "../../packaging/update-key.pub" with { type: "text" };

/**
 * Self-update, verified end to end:
 *
 *   1. The latest release is read from GitHub (api.github.com, over TLS).
 *   2. SHA256SUMS.sig must be a valid Ed25519 signature of SHA256SUMS by the release key
 *      (the private half lives only in the release workflow's secrets; the public half
 *      is UPDATE_PUBLIC_KEY below). A compromised download host can't forge it.
 *   3. The downloaded file's SHA-256 must match its line in the signed SHA256SUMS, and the
 *      signed file name must carry the new version (no rollbacks, no mix-ups).
 *   4. The new version must be strictly newer than the running one.
 *   5. macOS: the staged app must pass `codesign --verify --deep --strict`.
 *   6. The swap is atomic (rename) with rollback; nothing is executed before it passes.
 */

/** Ed25519 public key (PEM / SPKI) whose private half signs every release's SHA256SUMS. */
export const UPDATE_PUBLIC_KEY: string = updateKeyPem as unknown as string;
export const REPO = "BackendStack21/codeviewer";

export type InstallKind = "macos-app" | "linux-app" | "cli" | "source";

export interface Install {
  kind: InstallKind;
  /** What gets replaced: the .app bundle, the package directory, or the binary. */
  target: string;
  /** Release asset for a given version. */
  asset(version: string): string;
}

/** Works out how this copy of codeviewer was installed, from the executable's location. */
export function detectInstall(
  execPath = process.execPath,
  platform: string = process.platform,
  arch: string = process.arch,
  exists: (p: string) => boolean = existsSync,
): Install {
  let exe = execPath;
  try {
    exe = realpathSync(execPath);
  } catch {}
  const a = arch === "arm64" ? "arm64" : "x64";
  if (/^bun(-debug)?(\.exe)?$/.test(path.basename(exe))) {
    return { kind: "source", target: "", asset: () => "" };
  }
  const app = /^(.*\.app)\/Contents\/Resources\/codeviewer$/.exec(exe);
  if (platform === "darwin" && app) {
    return { kind: "macos-app", target: app[1]!, asset: (v) => `Codeviewer-${v}-macos-${a}.dmg` };
  }
  const dir = path.dirname(exe);
  if (platform === "linux" && exists(path.join(dir, "chromium", "chrome"))) {
    return { kind: "linux-app", target: dir, asset: (v) => `codeviewer-${v}-linux-${a}.tar.gz` };
  }
  const os = platform === "darwin" ? "macos" : "linux";
  const musl = platform === "linux" && a === "x64" && exists("/lib/ld-musl-x86_64.so.1");
  return { kind: "cli", target: exe, asset: (v) => `codeviewer-${v}-${os}-${a}${musl ? "-musl" : ""}` };
}

/** Compares "1.2.3" style versions (a pre-release sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    // Build metadata (+sha) never orders; everything after the first "-" is the pre-release.
    const base = v.replace(/^v/, "").replace(/\+.*$/, "");
    const dash = base.indexOf("-");
    const core = dash < 0 ? base : base.slice(0, dash);
    const pre = dash < 0 ? "" : base.slice(dash + 1);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  // Semver §11: dot-separated identifiers, numeric ones numerically (rc.10 > rc.9), numeric
  // before alphanumeric, and a prefix before anything longer.
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d) return Math.sign(d);
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export interface Release {
  version: string;
  url: string;
  notes: string;
  assets: Record<string, string>;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  kind: InstallKind;
  canInstall: boolean;
  /** Why an available update can't be installed automatically. */
  reason?: string;
  url?: string;
  notes?: string;
  checkedAt: number;
}

export type Phase = "download" | "signature" | "checksum" | "install" | "done";

export interface UpdaterOptions {
  version: string;
  fetch?: typeof fetch;
  publicKey?: string;
  install?: Install;
  api?: string;
  /** Hosts release assets may be downloaded from (always over https); defaults to GitHub's. */
  assetHosts?: string[];
}

/** Where GitHub serves release assets (the initial URL; GitHub's own redirects are followed). */
export const ASSET_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
/** SHA256SUMS and its signature are tiny; a hostile host must not make us buffer gigabytes. */
const MAX_SUMS_BYTES = 1 << 20;
/** No release asset is anywhere near this; the download stops here before any verification. */
const MAX_ASSET_BYTES = 1024 * 1024 * 1024;

/** Parses a SHA256SUMS file into name → hex digest. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (m) out.set(m[2]!, m[1]!);
  }
  return out;
}

/** Imports an Ed25519 public key from PEM (SPKI). */
export async function importPublicKey(pem: string): Promise<CryptoKey | null> {
  const b64 = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  try {
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey("spki", der as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return null;
  }
}

/** Verifies an Ed25519 signature (raw 64 bytes, or base64 of them) over `data`. */
export async function verifySignature(publicKeyPem: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await importPublicKey(publicKeyPem);
  if (!key) return false;
  let sig = signature;
  if (sig.length !== 64) {
    try {
      sig = Uint8Array.from(atob(new TextDecoder().decode(sig).trim()), (c) => c.charCodeAt(0));
    } catch {
      return false;
    }
  }
  if (sig.length !== 64) return false;
  return crypto.subtle.verify("Ed25519", key, sig as BufferSource, data as BufferSource);
}

export class Updater {
  readonly install: Install;
  private version: string;
  private fetch: typeof fetch;
  private publicKey: string;
  private api: string;
  private assetHosts: string[];
  private cached: { info: UpdateInfo; release: Release | null } | null = null;
  private busy = false;

  constructor(o: UpdaterOptions) {
    this.version = o.version;
    this.fetch = o.fetch ?? globalThis.fetch;
    this.publicKey = o.publicKey ?? UPDATE_PUBLIC_KEY;
    this.install = o.install ?? detectInstall();
    this.api = o.api ?? `https://api.github.com/repos/${REPO}/releases/latest`;
    this.assetHosts = o.assetHosts ?? ASSET_HOSTS;
  }

  /** Release assets come only from the release host, over TLS: the API answer names the URLs. */
  private assetUrl(url: string): string {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("release asset has an invalid URL");
    }
    if (u.protocol !== "https:" || !this.assetHosts.includes(u.hostname)) throw new Error(`refusing to download from ${u.host}`);
    return u.href;
  }

  get installing() {
    return this.busy;
  }

  /** Latest release vs. the running version. Cached for an hour unless forced. */
  async check(force = false): Promise<UpdateInfo> {
    if (!force && this.cached && Date.now() - this.cached.info.checkedAt < 3600_000) return this.cached.info;
    const base: UpdateInfo = {
      current: this.version, latest: null, available: false, kind: this.install.kind, canInstall: false, checkedAt: Date.now(),
    };
    const res = await this.fetch(this.api, { headers: { accept: "application/vnd.github+json", "user-agent": `codeviewer/${this.version}` } });
    if (!res.ok) throw new Error(`update check failed: GitHub answered ${res.status}`);
    const rel = (await res.json()) as { tag_name?: string; html_url?: string; body?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; browser_download_url: string }[] };
    const version = (rel.tag_name ?? "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+/.test(version) || rel.draft || rel.prerelease) {
      this.cached = { info: base, release: null };
      return base;
    }
    const release: Release = {
      version,
      url: rel.html_url ?? `https://github.com/${REPO}/releases`,
      notes: (rel.body ?? "").slice(0, 4000),
      assets: Object.fromEntries((rel.assets ?? []).map((a) => [a.name, a.browser_download_url])),
    };
    const info: UpdateInfo = {
      ...base,
      latest: version,
      available: compareVersions(version, this.version) > 0,
      url: release.url,
      notes: release.notes,
    };
    if (info.available) {
      const why = await this.cannotInstall(release);
      info.canInstall = !why;
      if (why) info.reason = why;
    }
    this.cached = { info, release };
    return info;
  }

  private async cannotInstall(r: Release): Promise<string | null> {
    const inst = this.install;
    if (inst.kind === "source") return "Running from source: update with `git pull`.";
    if (!r.assets[inst.asset(r.version)]) return `This release has no build for your platform (${inst.asset(r.version)}).`;
    if (!r.assets["SHA256SUMS"] || !r.assets["SHA256SUMS.sig"]) return "This release isn't signed, so it can't be installed automatically.";
    if (!this.publicKey.includes("BEGIN PUBLIC KEY")) return "This build has no update signing key.";
    try {
      await access(path.dirname(inst.target), constants.W_OK);
    } catch {
      return `No permission to replace ${inst.target}.`;
    }
    return null;
  }

  private async get(url: string): Promise<Uint8Array> {
    const res = await this.fetch(this.assetUrl(url), { headers: { "user-agent": `codeviewer/${this.version}` } });
    if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
    if (Number(res.headers.get("content-length")) > MAX_SUMS_BYTES) throw new Error("checksum file is too large");
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length > MAX_SUMS_BYTES) throw new Error("checksum file is too large");
    return body;
  }

  /**
   * Downloads, verifies and installs the latest release. `progress` reports each phase.
   * Resolves with the installed version; the caller restarts the app.
   */
  async apply(progress: (phase: Phase, detail?: string) => void = () => {}): Promise<{ version: string; kind: InstallKind; target: string }> {
    if (this.busy) throw new Error("an update is already being installed");
    this.busy = true;
    try {
      const info = await this.check(true);
      const release = this.cached?.release;
      if (!info.available || !release) throw new Error("already up to date");
      if (!info.canInstall) throw new Error(info.reason ?? "this update can't be installed automatically");
      const inst = this.install;
      const name = inst.asset(release.version);

      // 1. Signed checksum list.
      progress("signature");
      const sums = await this.get(release.assets["SHA256SUMS"]!);
      const sig = await this.get(release.assets["SHA256SUMS.sig"]!);
      if (!(await verifySignature(this.publicKey, sums, sig))) throw new Error("SHA256SUMS signature is invalid: refusing to install");
      const expected = parseSums(new TextDecoder().decode(sums)).get(name);
      if (!expected) throw new Error(`${name} is not in the signed checksum list`);
      if (!name.includes(`-${release.version}-`) && !name.endsWith(`-${release.version}`)) throw new Error("signed file name doesn't match the release version");

      // 2. Download into a staging dir next to the target (same file system → atomic rename).
      const stage = await mkdtemp(path.join(path.dirname(inst.target), ".codeviewer-update-"));
      try {
        const file = path.join(stage, name);
        const actual = await this.download(release.assets[name]!, file, (pct) => progress("download", `${pct}%`));

        // 3. Checksum.
        progress("checksum");
        if (actual !== expected) throw new Error(`checksum mismatch for ${name}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);

        // 4. Install.
        progress("install");
        if (inst.kind === "cli") {
          await chmod(file, 0o755);
          await rename(file, inst.target); // atomic replace of the binary
        } else {
          const staged = inst.kind === "macos-app" ? await stageMacApp(file, stage) : await stageLinuxPackage(file, stage);
          await swap(inst.target, staged, stage);
        }
        progress("done", release.version);
        this.cached = null;
        return { version: release.version, kind: inst.kind, target: inst.target };
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      this.busy = false;
    }
  }

  /** Streams a download to disk, hashing as it goes. Returns the hex SHA-256. */
  private async download(url: string, dest: string, pct: (n: number) => void): Promise<string> {
    const res = await this.fetch(this.assetUrl(url), { headers: { "user-agent": `codeviewer/${this.version}` } });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const total = Number(res.headers.get("content-length")) || 0;
    if (total > MAX_ASSET_BYTES) throw new Error("release asset is too large");
    const hash = new Bun.CryptoHasher("sha256");
    const sink = Bun.file(dest).writer();
    let got = 0;
    let last = -1;
    const reader = res.body.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      got += r.value.length;
      if (got > MAX_ASSET_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("release asset is too large");
      }
      hash.update(r.value);
      sink.write(r.value);
      const p = total ? Math.floor((got / total) * 100) : 0;
      if (p !== last) {
        last = p;
        pct(p);
      }
    }
    await sink.end();
    return hash.digest("hex");
  }
}

async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${path.basename(cmd[0]!)} failed: ${(err || out).trim().split("\n")[0]}`);
  return out;
}

/** Mounts the DMG, copies Codeviewer.app out (signature intact) and verifies its code signature. */
async function stageMacApp(dmg: string, stage: string): Promise<string> {
  const mnt = path.join(stage, "mnt");
  await mkdir(mnt);
  await sh(["hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, dmg]);
  const staged = path.join(stage, "Codeviewer.app");
  try {
    if (!existsSync(path.join(mnt, "Codeviewer.app"))) throw new Error("the disk image has no Codeviewer.app");
    await sh(["ditto", path.join(mnt, "Codeviewer.app"), staged]);
  } finally {
    await sh(["hdiutil", "detach", mnt, "-quiet"]).catch(() => {});
  }
  await sh(["codesign", "--verify", "--deep", "--strict", staged]);
  return staged;
}

/** Extracts the Linux package and checks it has the expected layout. */
async function stageLinuxPackage(tgz: string, stage: string): Promise<string> {
  const out = path.join(stage, "extract");
  await mkdir(out);
  await sh(["tar", "-xzf", tgz, "-C", out, "--no-same-owner"]);
  const entries = await readdir(out);
  const dir = path.join(out, entries[0] ?? "");
  if (entries.length !== 1 || !existsSync(path.join(dir, "codeviewer")) || !existsSync(path.join(dir, "chromium", "chrome"))) {
    throw new Error("unexpected package layout");
  }
  return dir;
}

/** Atomically replaces `target` with `staged`; restores the original if the second step fails. */
async function swap(target: string, staged: string, stage: string) {
  const old = path.join(stage, "previous");
  await rename(target, old);
  try {
    await rename(staged, target);
  } catch (e) {
    await rename(old, target).catch(() => {});
    throw e;
  }
}
