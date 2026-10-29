// Build pipeline (no dependencies):
//   1. bundle + minify the client (src/client) into dist/client
//   2. compile the server, with the client and fonts embedded, into standalone executables
//   3. package apps: macOS → Codeviewer.app (native WebKit shell) in a .dmg;
//                    Linux → tarball with a verified ungoogled-chromium build
//
//   bun scripts/build.ts                 # everything: slim binaries + apps for all targets
//   bun scripts/build.ts --local         # this machine only (slim binary + app)
//   bun scripts/build.ts --slim          # slim binaries only (no packaging)
//   bun scripts/build.ts --client-only   # just the client bundle (dev / tests)
//   bun scripts/build.ts --browser <tag|latest>  # re-pin the Linux browser (updates packaging/browser-pins.json)
import { mkdir, rm, copyFile, writeFile, stat, readdir, rename, chmod, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outClient = path.join(root, "dist/client");
const outBin = path.join(root, "dist/bin");
const outApp = path.join(root, "dist/app");
const outRelease = path.join(root, "dist/release");
const cacheDir = path.join(root, ".cache/browser");
const argv = process.argv.slice(2);
const args = new Set(argv);
const browserTag = argv.includes("--browser") ? argv[argv.indexOf("--browser") + 1] : null;
const VERSION = (await Bun.file(path.join(root, "package.json")).json()).version as string;

interface Target {
  bun: string;
  name: string;
  os: "macos" | "linux";
  arch: "arm64" | "x64";
  /** Linux: ungoogled-chromium release asset to bundle; null = slim binary only. */
  asset: RegExp | null;
}

const TARGETS: Target[] = [
  { bun: "bun-darwin-arm64", name: "macos-arm64", os: "macos", arch: "arm64", asset: null },
  { bun: "bun-darwin-x64", name: "macos-x64", os: "macos", arch: "x64", asset: null },
  { bun: "bun-linux-x64", name: "linux-x64", os: "linux", arch: "x64", asset: /-x86_64_linux\.tar\.xz$/ },
  { bun: "bun-linux-arm64", name: "linux-arm64", os: "linux", arch: "arm64", asset: /-arm64_linux\.tar\.xz$/ },
  { bun: "bun-linux-x64-musl", name: "linux-x64-musl", os: "linux", arch: "x64", asset: null },
];


const log = (s: string) => console.log(s);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function sh(cmd: string[], opts: { cwd?: string } = {}) {
  const p = Bun.spawn(cmd, { cwd: opts.cwd ?? root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}):\n${err || out}`);
  return out;
}

// ───────────────────────────── client ─────────────────────────────

async function buildClient() {
  await rm(outClient, { recursive: true, force: true });
  await mkdir(outClient, { recursive: true });
  const res = await Bun.build({
    entrypoints: [path.join(root, "src/client/app.ts")],
    outdir: outClient,
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    naming: "app.js",
  });
  if (!res.success) {
    for (const l of res.logs) console.error(l);
    process.exit(1);
  }
  const css = await Bun.file(path.join(root, "src/client/styles.css")).text();
  await writeFile(path.join(outClient, "app.css"), minifyCss(css));
  await copyFile(path.join(root, "src/client/index.html"), path.join(outClient, "index.html"));
  await copyFile(path.join(root, "src/client/favicon.svg"), path.join(outClient, "favicon.svg"));
  log(`client   app.js ${((await stat(path.join(outClient, "app.js"))).size / 1024).toFixed(1)} KB`);
}

/** Conservative CSS minifier: strips comments and collapses whitespace. */
function minifyCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

// ───────────────────────────── binaries ─────────────────────────────

async function compile(target: string | null, outfile: string) {
  await mkdir(path.dirname(outfile), { recursive: true });
  const cmd = ["bun", "build", "--compile", "--minify", "--sourcemap=none", path.join(root, "src/server/main.ts"), path.join(root, "src/server/search.worker.ts"), "--outfile", outfile];
  if (target) cmd.push(`--target=${target}`);
  await sh(cmd);
  log(`binary   ${path.relative(root, outfile)} ${mb((await stat(outfile)).size)}`);
}

// ───────────────────────────── browser ─────────────────────────────

interface Asset {
  name: string;
  url: string;
  sha256: string;
  tag: string;
}

const releaseCache = new Map<string, Promise<{ tag_name: string; assets: { name: string; browser_download_url: string; digest?: string }[] }>>();

interface Pins {
  repo: string;
  tag: string;
  sha256: Record<string, string>;
}
const PINS_FILE = path.join(root, "packaging/browser-pins.json");

/**
 * The browser is pinned in the repo (tag + SHA-256 per asset), so a compromised or
 * replaced upstream release can't slip into a build. `--browser <tag|latest>` re-pins
 * deliberately, using the digests GitHub publishes, and rewrites the pins file.
 */
async function browserAsset(t: Target): Promise<Asset> {
  const pins = (await Bun.file(PINS_FILE).json()) as Pins;
  if (browserTag) {
    const api = `https://api.github.com/repos/${pins.repo}/releases/${browserTag === "latest" ? "latest" : `tags/${browserTag}`}`;
    if (!releaseCache.has(api)) {
      releaseCache.set(
        api,
        fetch(api, { headers: { accept: "application/vnd.github+json", "user-agent": "codeviewer-build" } }).then(async (r) => {
          if (!r.ok) throw new Error(`GitHub API ${r.status} for ${api}`);
          return r.json();
        }),
      );
    }
    const rel = await releaseCache.get(api)!;
    const a = rel.assets.find((x) => t.asset!.test(x.name));
    if (!a?.digest?.startsWith("sha256:")) throw new Error(`no verifiable ${t.asset} asset in ${pins.repo}@${rel.tag_name}`);
    if (pins.tag !== rel.tag_name) Object.assign(pins, { tag: rel.tag_name, sha256: {} });
    pins.sha256[a.name] = a.digest.slice(7);
    await writeFile(PINS_FILE, JSON.stringify(pins, null, 2) + "\n");
    log(`browser  re-pinned ${a.name} → ${a.digest.slice(7, 23)}…`);
  }
  const name = Object.keys(pins.sha256).find((n) => t.asset!.test(n));
  if (!name) throw new Error(`no pinned asset for ${t.name} in packaging/browser-pins.json`);
  const url = `https://github.com/${pins.repo}/releases/download/${encodeURIComponent(pins.tag)}/${encodeURIComponent(name)}`;
  return { name, url, sha256: pins.sha256[name]!, tag: pins.tag };
}

async function sha256(file: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(file).stream().getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) h.update(r.value);
  return h.digest("hex");
}

/** Downloads (cached) and verifies the browser archive. */
async function fetchBrowser(a: Asset): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const file = path.join(cacheDir, a.name);
  if (existsSync(file) && (await sha256(file)) === a.sha256) return file;
  log(`browser  downloading ${a.name}`);
  const res = await fetch(a.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${a.url}`);
  const tmp = `${file}.part`;
  await Bun.write(tmp, res);
  const got = await sha256(tmp);
  if (got !== a.sha256) {
    await rm(tmp, { force: true });
    throw new Error(`SHA-256 mismatch for ${a.name}: expected ${a.sha256}, got ${got}`);
  }
  await rename(tmp, file);
  log(`browser  verified sha256 ${a.sha256.slice(0, 16)}…`);
  return file;
}

async function extractLinuxBrowser(tarxz: string, dest: string) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cv-tar-"));
  try {
    await sh(["tar", "-xJf", tarxz, "-C", tmp]);
    const [top] = await readdir(tmp);
    if (!top || !existsSync(path.join(tmp, top, "chrome"))) throw new Error(`unexpected layout in ${tarxz}`);
    await rename(path.join(tmp, top), dest);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ───────────────────────────── packaging ─────────────────────────────

async function licenses(dir: string, browserTag: string | null) {
  await mkdir(dir, { recursive: true });
  await copyFile(path.join(root, "vendor/fonts/JetBrainsMono-OFL.txt"), path.join(dir, "JetBrainsMono-OFL.txt"));
  await copyFile(path.join(root, "vendor/fonts/Inter-OFL.txt"), path.join(dir, "Inter-OFL.txt"));
  await writeFile(
    path.join(dir, "THIRD_PARTY.txt"),
    `Codeviewer ${VERSION} bundles:\n\n` +
      (browserTag
        ? `- ungoogled-chromium ${browserTag} (BSD-3-Clause and others; see the browser's about:credits)\n` +
          `  https://github.com/ungoogled-software\n`
        : "") +
      `- JetBrains Mono 2.304 (SIL Open Font License 1.1)\n` +
      `- Inter 4.1 (SIL Open Font License 1.1)\n`,
  );
}

let iconPromise: Promise<string | null> | null = null;

/** Rasterizes packaging/icon.svg (transparent) and builds AppIcon.icns. */
function makeIcns(): Promise<string | null> {
  iconPromise ??= (async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), "cv-icon-"));
    try {
      // Rasterize with AppKit (QuickLook thumbnails come with an opaque white background).
      const tool = path.join(work, "svg2png");
      await sh(["xcrun", "swiftc", "-O", path.join(root, "packaging/macos/svg2png.swift"), "-o", tool, "-framework", "Cocoa"]);
      const png = path.join(work, "icon-1024.png");
      await sh([tool, path.join(root, "packaging/icon.svg"), png, "1024"]);
      const set = path.join(work, "AppIcon.iconset");
      await mkdir(set);
      for (const s of [16, 32, 128, 256, 512]) {
        await sh(["sips", "-z", String(s), String(s), png, "--out", path.join(set, `icon_${s}x${s}.png`)]);
        await sh(["sips", "-z", String(s * 2), String(s * 2), png, "--out", path.join(set, `icon_${s}x${s}@2x.png`)]);
      }
      const icns = path.join(work, "AppIcon.icns");
      await sh(["iconutil", "-c", "icns", set, "-o", icns]);
      return icns;
    } catch (e) {
      console.warn(`warn     icon rendering failed: ${(e as Error).message.split("\n")[0]}`);
      return null;
    }
  })();
  return iconPromise;
}

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Codeviewer</string>
  <key>CFBundleDisplayName</key><string>Codeviewer</string>
  <key>CFBundleIdentifier</key><string>de.21no.codeviewer</string>
  <key>CFBundleExecutable</key><string>Codeviewer</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.3</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Fonts: JetBrains Mono, Inter (SIL OFL 1.1)</string>
  <!-- The web view only ever talks to the loopback server. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <!-- Folders can be dropped on the Dock icon or opened with "Open With". -->
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Folder</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.folder</string></array>
    </dict>
  </array>
</dict>
</plist>
`;

async function packageMac(t: Target, bin: string) {
  if (process.platform !== "darwin") {
    console.warn(`skip     ${t.name} app (needs a macOS host with Xcode command line tools)`);
    return;
  }
  const app = path.join(outApp, t.name, "Codeviewer.app");
  await rm(path.dirname(app), { recursive: true, force: true });
  const contents = path.join(app, "Contents");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  await mkdir(path.join(contents, "Resources"), { recursive: true });
  // Native shell: AppKit + WebKit, compiled for the target architecture.
  const arch = t.arch === "arm64" ? "arm64" : "x86_64";
  await sh([
    "xcrun", "swiftc", "-O", "-target", `${arch}-apple-macos13.3`, "-framework", "Cocoa", "-framework", "WebKit",
    path.join(root, "packaging/macos/main.swift"), "-o", path.join(contents, "MacOS", "Codeviewer"),
  ]);
  await copyFile(bin, path.join(contents, "Resources", "codeviewer"));
  await chmod(path.join(contents, "Resources", "codeviewer"), 0o755);
  await writeFile(path.join(contents, "Info.plist"), INFO_PLIST);
  await writeFile(path.join(contents, "PkgInfo"), "APPL????");
  await licenses(path.join(contents, "Resources", "Licenses"), null);
  const icns = await makeIcns();
  if (icns) await copyFile(icns, path.join(contents, "Resources", "AppIcon.icns"));
  // Ad-hoc signature (no Developer ID available): seals the bundle so it can't be modified unnoticed.
  await sh(["codesign", "--force", "--deep", "--sign", "-", app]);
  await sh(["codesign", "--verify", "--deep", "--strict", app]);

  // Drag-to-install disk image: the app next to an /Applications shortcut.
  const stage = await mkdtemp(path.join(os.tmpdir(), "cv-dmg-"));
  try {
    await sh(["ditto", app, path.join(stage, "Codeviewer.app")]);
    await sh(["ln", "-s", "/Applications", path.join(stage, "Applications")]);
    await mkdir(outRelease, { recursive: true });
    const dmg = path.join(outRelease, `Codeviewer-${VERSION}-${t.name}.dmg`);
    await rm(dmg, { force: true });
    await sh(["hdiutil", "create", "-volname", "Codeviewer", "-srcfolder", stage, "-fs", "HFS+", "-format", "ULFO", "-ov", dmg]);
    log(`app      ${path.relative(root, dmg)} ${mb((await stat(dmg)).size)}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const INSTALL_SH = `#!/bin/sh
# Installs Codeviewer for the current user: a launcher in ~/.local/bin and a desktop entry.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/scalable/apps"
ln -sf "$HERE/codeviewer" "$HOME/.local/bin/codeviewer"
cp "$HERE/share/codeviewer.desktop" "$HOME/.local/share/applications/codeviewer.desktop"
cp "$HERE/share/codeviewer.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/codeviewer.svg"
echo "Installed. Run 'codeviewer [dir]' or launch Codeviewer from your app menu."
if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = "0" ] || \\
   [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
  echo
  echo "Note: this kernel restricts the user namespaces Chromium's sandbox uses."
  echo "Enable the setuid sandbox once with:"
  echo "  sudo chown root:root '$HERE/chromium/chrome-sandbox' && sudo chmod 4755 '$HERE/chromium/chrome-sandbox'"
fi
`;

async function packageLinux(t: Target, bin: string) {
  const asset = await browserAsset(t);
  const tarxz = await fetchBrowser(asset);
  const dir = path.join(outApp, t.name, "codeviewer");
  await rm(path.dirname(dir), { recursive: true, force: true });
  await mkdir(path.join(dir, "share"), { recursive: true });
  await extractLinuxBrowser(tarxz, path.join(dir, "chromium"));
  await copyFile(bin, path.join(dir, "codeviewer"));
  await chmod(path.join(dir, "codeviewer"), 0o755);
  await copyFile(path.join(root, "packaging/codeviewer.desktop"), path.join(dir, "share/codeviewer.desktop"));
  await copyFile(path.join(root, "packaging/icon.svg"), path.join(dir, "share/codeviewer.svg"));
  await writeFile(path.join(dir, "install.sh"), INSTALL_SH, { mode: 0o755 });
  await licenses(path.join(dir, "licenses"), asset.tag);
  await mkdir(outRelease, { recursive: true });
  const tgz = path.join(outRelease, `codeviewer-${VERSION}-${t.name}.tar.gz`);
  await sh(["tar", "-czf", tgz, "-C", path.dirname(dir), "codeviewer"]);
  log(`app      ${path.relative(root, tgz)} ${mb((await stat(tgz)).size)} (ungoogled-chromium ${asset.tag})`);
}

// ───────────────────────────── main ─────────────────────────────

await buildClient();
if (args.has("--client-only")) process.exit(0);

const hostName = `${process.platform === "darwin" ? "macos" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const targets = args.has("--local") ? TARGETS.filter((t) => t.name === hostName) : TARGETS;
if (!targets.length) throw new Error(`unsupported host ${hostName}`);

let failed = false;
for (const t of targets) {
  try {
    const bin = path.join(outBin, args.has("--local") ? "codeviewer" : `codeviewer-${t.name}`);
    await compile(args.has("--local") ? null : t.bun, bin);
    if (args.has("--slim")) continue;
    // The slim, browser-less CLI is a release asset too (headless / SSH / --no-open use).
    await mkdir(outRelease, { recursive: true });
    await copyFile(bin, path.join(outRelease, `codeviewer-${VERSION}-${t.name}`));
    if (t.os === "macos") await packageMac(t, bin);
    else if (t.asset) await packageLinux(t, bin);
  } catch (e) {
    failed = true;
    console.error(`✗ ${t.name}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);

// SHA256SUMS for every release asset (verified by users with `shasum -a 256 -c`).
if (!args.has("--slim") && existsSync(outRelease)) {
  const names = (await readdir(outRelease)).filter((n) => n !== "SHA256SUMS" && !n.startsWith(".")).sort();
  let sums = "";
  for (const n of names) sums += `${await sha256(path.join(outRelease, n))}  ${n}\n`;
  await writeFile(path.join(outRelease, "SHA256SUMS"), sums);
  log(`sums     dist/release/SHA256SUMS (${names.length} files)`);
}
