// Generates docs/index.html, the landing page served by Cloudflare Pages at
// https://codeviewer.21no.de (output directory: docs/, no build command).
//
// docs/ holds the static site (site.css, site.js, assets/, fonts/, _headers). Only
// index.html is generated, because it embeds each download's size and SHA-256.
//
//   bun run site                # re-render using the published release in docs/release.json
//   bun run site -- --release   # read dist/release (+ SHA256SUMS), write docs/release.json:
//                               # used by the release workflow only
//
// Local builds aren't byte-identical to CI builds, so only the release workflow records
// checksums: the page and the GitHub release always describe the same files, and editing
// the page can never wipe them.
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const out = path.join(root, "docs");
const releaseDir = path.join(root, "dist/release");
const pkg = (await Bun.file(path.join(root, "package.json")).json()) as { version: string; repository: { url: string } };
const useRelease = process.argv.includes("--release");
const RELEASE_JSON = path.join(root, "docs/release.json");

/** Published release: name → size + SHA-256, and whether SHA256SUMS is signed. */
interface ReleaseData {
  version: string;
  signed: boolean;
  files: Record<string, { size: number; sha256: string }>;
}

let release: ReleaseData | null = null;
if (useRelease) {
  const sums = existsSync(path.join(releaseDir, "SHA256SUMS")) ? await Bun.file(path.join(releaseDir, "SHA256SUMS")).text() : "";
  const files: ReleaseData["files"] = {};
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && existsSync(path.join(releaseDir, m[2]!))) files[m[2]!] = { sha256: m[1]!, size: (await stat(path.join(releaseDir, m[2]!))).size };
  }
  release = { version: pkg.version, signed: existsSync(path.join(releaseDir, "SHA256SUMS.sig")), files };
} else if (existsSync(RELEASE_JSON)) {
  release = (await Bun.file(RELEASE_JSON).json()) as ReleaseData;
}
// File names and links follow the published release (package.json may already be ahead).
const VERSION = release?.version ?? pkg.version;
const REPO = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""); // https://github.com/owner/name
const REPO_SLUG = REPO.replace("https://github.com/", "");
const DL = `${REPO}/releases/download/v${VERSION}`;
const DOMAIN = "codeviewer.21no.de";

interface Download {
  id: string;
  os: "macos" | "linux";
  label: string;
  detail: string;
  file: string;
  kind: "app" | "cli";
  size: number | null;
  sha256: string | null;
}

const PLATFORMS: Omit<Download, "size" | "sha256">[] = [
  { id: "macos-arm64", os: "macos", label: "macOS", detail: "Apple silicon", file: `Codeviewer-${VERSION}-macos-arm64.dmg`, kind: "app" },
  { id: "macos-x64", os: "macos", label: "macOS", detail: "Intel", file: `Codeviewer-${VERSION}-macos-x64.dmg`, kind: "app" },
  { id: "linux-x64", os: "linux", label: "Linux", detail: "x86-64", file: `codeviewer-${VERSION}-linux-x64.tar.gz`, kind: "app" },
  { id: "linux-arm64", os: "linux", label: "Linux", detail: "ARM64", file: `codeviewer-${VERSION}-linux-arm64.tar.gz`, kind: "app" },
  { id: "cli-macos-arm64", os: "macos", label: "macOS CLI", detail: "Apple silicon", file: `codeviewer-${VERSION}-macos-arm64`, kind: "cli" },
  { id: "cli-macos-x64", os: "macos", label: "macOS CLI", detail: "Intel", file: `codeviewer-${VERSION}-macos-x64`, kind: "cli" },
  { id: "cli-linux-x64", os: "linux", label: "Linux CLI", detail: "x86-64 (glibc)", file: `codeviewer-${VERSION}-linux-x64`, kind: "cli" },
  { id: "cli-linux-arm64", os: "linux", label: "Linux CLI", detail: "ARM64 (glibc)", file: `codeviewer-${VERSION}-linux-arm64`, kind: "cli" },
  { id: "cli-linux-x64-musl", os: "linux", label: "Linux CLI", detail: "x86-64 (musl / Alpine)", file: `codeviewer-${VERSION}-linux-x64-musl`, kind: "cli" },
];

// ───────────────────────────── release data ─────────────────────────────

const downloads: Download[] = PLATFORMS.map((p) => {
  const f = release?.files[p.file];
  return { ...p, size: f?.size ?? null, sha256: f?.sha256 ?? null };
});
const missing = downloads.filter((d) => !d.sha256);
// Releases from 1.1 on sign SHA256SUMS (the in-app updater requires it).
const signed = !!release?.signed;
const KEY_URL = `${REPO.replace("github.com", "raw.githubusercontent.com")}/main/packaging/update-key.pub`;
const sigStep = (os: "macos" | "linux") =>
  signed
    ? `<li><h3>Check the release signature</h3>${code(
        `curl -LO ${DL}/SHA256SUMS.sig\ncurl -fsSLo codeviewer.pub ${KEY_URL}\nopenssl pkeyutl -verify -pubin -inkey codeviewer.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig`,
      )}<p class="note">Expect <code>Signature Verified Successfully</code>. Needs OpenSSL 3 or newer${os === "macos" ? " (<code>brew install openssl</code>; the built-in one is LibreSSL)" : ""}. This is the same Ed25519 signature the in-app updater checks before installing anything.</p></li>`
    : "";
if (useRelease && missing.length) {
  throw new Error(`release incomplete, refusing to publish without checksums for: ${missing.map((d) => d.file).join(", ")}`);
}

// ───────────────────────────── helpers ─────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const mb = (n: number | null) => (n === null ? "" : `${(n / 1024 / 1024).toFixed(0)} MB`);
const url = (file: string) => `${DL}/${file}`;

const ICON = {
  apple: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.7c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9s-2-.9-3.3-.9c-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.3.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.8-1.1-2.8-4.1zM13.9 5.3c.7-.8 1.2-2 1-3.2-1 0-2.3.7-3 1.5-.7.7-1.2 1.9-1.1 3.1 1.2.1 2.4-.6 3.1-1.4z"/></svg>`,
  linux: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2c-2.2 0-3.6 1.9-3.6 4.6 0 1.4.3 2.3-.5 3.6-1 1.6-2.8 3.6-2.8 6.1 0 .9.2 1.6.6 2.1-.7.4-1.4.9-1.4 1.6 0 1.2 2 1.4 3.5 1.8 1.3.3 2.1.9 3 .9 1 0 1.6-.6 1.9-.6h.6c.3 0 .9.6 1.9.6.9 0 1.7-.6 3-.9 1.5-.4 3.5-.6 3.5-1.8 0-.7-.7-1.2-1.4-1.6.4-.5.6-1.2.6-2.1 0-2.5-1.8-4.5-2.8-6.1-.8-1.3-.5-2.2-.5-3.6C15.6 3.9 14.2 2 12 2zm-1.6 4.2c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zm3.2 0c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zM12 9.4c.9 0 2 .6 2 1s-1.1 1.1-2 1.1-2-.7-2-1.1 1.1-1 2-1z"/></svg>`,
  download: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  copy: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  check: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  github: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.6 0 0 3.6 0 8c0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8.6-.2 1.3-.3 2-.3s1.4.1 2 .3c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4C13.7 14.5 16 11.5 16 8c0-4.4-3.6-8-8-8z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const code = (cmd: string) =>
  `<div class="cmd"><pre><code>${cmd
    .split("\n")
    .map((l) => (l.startsWith("#") ? `<span class="c"># ${esc(l.slice(1).trim())}</span>` : esc(l)))
    .join("\n")}</code></pre><button class="copy" type="button" data-copy="${esc(cmd.split("\n").filter((l) => !l.startsWith("#")).join("\n"))}" aria-label="Copy command">${ICON.copy}</button></div>`;

const FEATURES: [string, string, string][] = [
  ["terminal", "A real terminal, built in", "A native PTY and a from-scratch xterm-grade emulator: truecolor, mouse, alternate screen, bracketed paste and crisp box drawing. Run Claude Code, Codex, aider, vim or htop right next to the code."],
  ["live", "Live while agents work", "Files reload in place as they change on disk. Changed lines flash, the explorer marks them, and nothing you are reading jumps."],
  ["git", "Git, read-only", "Status letters in the explorer, gutter markers against HEAD with a peek at the old lines, inline blame, branch, ahead/behind and merge state. It never writes to your repository."],
  ["fast", "Fast at any size", "Virtualized everything: 100k-line files open instantly, quick-open searches 200k paths as you type, and the terminal streams megabytes per second."],
  ["lock", "Locked down", "The window can only reach its own local server. Header-token auth, DNS-rebinding and CSRF guards, and git hardened against hostile repositories. Reviewed adversarially."],
  ["native", "Native and small", "A 40 MB Mac app on the system WebKit, with real menus, window tabs and a folder picker. Built with Bun and TypeScript and zero third-party dependencies."],
];

const FEATURE_ICONS: Record<string, string> = {
  terminal: `<path d="M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4" />`,
  live: `<path d="M12 4a8 8 0 1 0 8 8M20 4v5h-5" />`,
  git: `<path d="M7 4v10M7 14a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17 9c0 4-10 3-10 5" />`,
  fast: `<path d="M13 3L5 14h6l-1 7 8-11h-6z" />`,
  lock: `<path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" />`,
  native: `<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 8.5h16M7 6.2h.01M9 6.2h.01" />`,
};

const row = (d: Download) => `
        <tr>
          <td><div class="plat">${d.os === "macos" ? ICON.apple : ICON.linux}<span><b>${esc(d.label)}</b><small>${esc(d.detail)}</small></span></div></td>
          <td><div class="file"><a href="${esc(url(d.file))}">${esc(d.file)}</a><small>${mb(d.size)}</small></div></td>
          <td class="hash">${
            d.sha256
              ? `<button class="sha" type="button" data-copy="${d.sha256}" title="Copy SHA-256"><code>${d.sha256.slice(0, 16)}…${d.sha256.slice(-8)}</code>${ICON.copy}</button>`
              : `<span class="muted">pending</span>`
          }</td>
        </tr>`;

const apps = downloads.filter((d) => d.kind === "app");
const clis = downloads.filter((d) => d.kind === "cli");
const primary = apps[0]!;

// ───────────────────────────── page ─────────────────────────────

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codeviewer: read the code, run the agent</title>
<meta name="description" content="A fast, read-only code viewer with a real built-in terminal and live git indicators. Watch your coding agent work, right next to the code. Free and open source (MIT).">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0c0f15">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="https://${DOMAIN}/">
<meta property="og:title" content="Codeviewer">
<meta property="og:description" content="Read the code. Run the agent. Same window. A fast, read-only code viewer with a real terminal and live git indicators.">
<meta property="og:image" content="https://${DOMAIN}/assets/screenshot-dark.jpg">
<meta property="og:url" content="https://${DOMAIN}/">
<meta name="twitter:card" content="summary_large_image">
<link rel="preload" href="fonts/SpaceGrotesk.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="site.css">
<script type="application/json" id="downloads">${JSON.stringify(apps.map(({ id, os, detail, file }) => ({ id, os, detail, file, url: url(file) })))}</script>
<script src="site.js" defer></script>
</head>
<body>
<header class="nav">
  <a class="brand" href="#top"><img src="assets/favicon.svg" alt="" width="22" height="22"><span>Codeviewer</span></a>
  <nav>
    <a href="#features">Features</a>
    <a href="#security">Security</a>
    <a href="#download">Download</a>
    <a class="gh" href="${REPO}" aria-label="Source on GitHub">${ICON.github}<span>GitHub</span></a>
  </nav>
</header>

<main id="top">
  <section class="hero">
    <p class="eyebrow"><span class="pill">Free</span> Open source · MIT licensed</p>
    <h1>Read the code.<br><span class="grad">Run the agent.</span> Same window.</h1>
    <p class="lede">Codeviewer is a fast, read-only code viewer with a real terminal built in. Point your favourite CLI agent at a project and watch every file it touches update live, with git telling you exactly what changed.</p>
    <div class="cta">
      <a class="btn primary" id="dl-primary" href="${esc(url(primary.file))}">${ICON.download}<span>Download for <b id="dl-os">macOS</b> <small id="dl-detail">${esc(primary.detail)}</small></span></a>
      <a class="btn ghost" href="#download">All platforms</a>
    </div>
    <p class="fine"><a href="#verify">${ICON.shield} Verify your download</a> · SHA-256 and signed build provenance for every file</p>
    <figure class="shot">
      <picture>
        <source srcset="assets/screenshot-light.jpg" media="(prefers-color-scheme: light)">
        <img src="assets/screenshot-dark.jpg" width="2400" height="1509" alt="Codeviewer showing a project's explorer with git status letters, a TypeScript file with git gutter markers and inline blame, and a terminal running git log.">
      </picture>
    </figure>
  </section>

  <section id="features" class="features">
    <h2>Built for watching code change</h2>
    <p class="sub">Everything an IDE shows you, nothing that lets anything slip in by accident: Codeviewer never edits a file.</p>
    <div class="grid">
${FEATURES.map(
  ([id, title, body]) => `      <article class="card">
        <svg class="ficon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${FEATURE_ICONS[id]}</g></svg>
        <h3>${title}</h3>
        <p>${body}</p>
      </article>`,
).join("\n")}
    </div>
  </section>

  <section class="split">
    <div>
      <h2>See what HEAD had</h2>
      <p>Click any gutter marker to peek at the lines as they were in the last commit. Inline blame follows your cursor; the status bar shows the branch, how far ahead or behind you are, and every changed file is one <kbd>⌘⇧G</kbd> away.</p>
      <ul class="ticks">
        <li>Explorer letters: <b class="gM">M</b> modified, <b class="gA">A</b> added, <b class="gU">U</b> untracked, <b class="gD">D</b> deleted, <b class="gC">C</b> conflict</li>
        <li>Live as you or an agent edit, stage, commit or switch branch</li>
        <li>Safe on untrusted repositories: no hooks, filters or drivers ever run</li>
      </ul>
    </div>
    <img class="shot-sm" src="assets/screenshot-light.jpg" width="2400" height="1509" alt="Light theme with a peek popup showing the HEAD version of a changed line." loading="lazy">
  </section>

  <section id="security" class="security">
    <h2>A shell in a window deserves care</h2>
    <p class="sub">Codeviewer serves a real terminal, so it was designed and then attacked by reviewers looking for a way in. Every confirmed finding was fixed and pinned with a test.</p>
    <div class="grid three">
      <article class="card"><h3>Only its own server</h3><p>The Mac window blocks every request except its own local port. External links open in your browser, never inside the app.</p></article>
      <article class="card"><h3>No ambient credentials</h3><p>A random 256-bit token lives in the URL fragment and a request header. No cookies, no token in process lists, Host and Origin checked on every request.</p></article>
      <article class="card"><h3>Hostile repos are fine</h3><p>Git runs without filters, textconv, signature checks, fsmonitor or submodules, and never writes your index. Read the <a href="${REPO}/blob/main/DESIGN.md">design and review notes</a>.</p></article>
    </div>
  </section>

  <section id="download" class="download">
    <h2>Download</h2>
    <p class="sub">The latest release. The apps are self-contained; the CLI binaries serve the viewer to any browser (<code>codeviewer . --no-open</code>).</p>
    <table class="dl">
      <thead><tr><th>Platform</th><th>File</th><th>SHA-256</th></tr></thead>
      <tbody>${apps.map(row).join("")}
      </tbody>
    </table>
    <details class="more">
      <summary>Command-line only (no window, any browser)</summary>
      <table class="dl"><tbody>${clis.map(row).join("")}
      </tbody></table>
    </details>
    <p class="fine">All files and the full <a href="${DL}/SHA256SUMS">SHA256SUMS</a> list are on the <a href="${REPO}/releases/tag/v${VERSION}">GitHub release</a>.</p>
  </section>

  <section id="verify" class="verify">
    <h2>Verify before you run it</h2>
    <p class="sub">Every release is built by <a href="${REPO}/blob/main/.github/workflows/release.yml">GitHub Actions</a> from a tagged commit, on a clean runner. Two independent checks prove the file you have is that build.</p>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="true" data-tab="macos">macOS</button>
      <button role="tab" aria-selected="false" data-tab="linux">Linux</button>
    </div>
    <div class="panel" data-panel="macos">
      <ol class="steps">
        <li><h3>Download the app and the checksum list</h3>${code(`curl -LO ${url(`Codeviewer-${VERSION}-macos-arm64.dmg`)}\ncurl -LO ${DL}/SHA256SUMS`)}<p class="note">Intel Mac: use <code>Codeviewer-${VERSION}-macos-x64.dmg</code>.</p></li>
        <li><h3>Check the SHA-256</h3>${code(`shasum -a 256 -c SHA256SUMS --ignore-missing`)}<p class="note">Expect <code>Codeviewer-${VERSION}-macos-arm64.dmg: OK</code>. It must also match the hash in the table above.</p></li>
        ${sigStep("macos")}
        <li><h3>Check where it was built</h3>${code(`# GitHub CLI: https://cli.github.com\ngh attestation verify Codeviewer-${VERSION}-macos-arm64.dmg --repo ${REPO_SLUG}`)}<p class="note">This checks a Sigstore-signed provenance statement logged in a public transparency log. It proves the file came out of this repository's release workflow, at a specific commit. It does not depend on this website.</p></li>
        <li><h3>Install</h3><p>Open the DMG and drag <b>Codeviewer</b> to <b>Applications</b>. The app is not notarized by Apple, so the first launch needs <b>right-click → Open</b>, or:</p>${code(`xattr -dr com.apple.quarantine /Applications/Codeviewer.app`)}</li>
      </ol>
    </div>
    <div class="panel" data-panel="linux" hidden>
      <ol class="steps">
        <li><h3>Download the package and the checksum list</h3>${code(`curl -LO ${url(`codeviewer-${VERSION}-linux-x64.tar.gz`)}\ncurl -LO ${DL}/SHA256SUMS`)}<p class="note">ARM64: use <code>codeviewer-${VERSION}-linux-arm64.tar.gz</code>.</p></li>
        <li><h3>Check the SHA-256</h3>${code(`sha256sum -c SHA256SUMS --ignore-missing`)}<p class="note">Expect <code>codeviewer-${VERSION}-linux-x64.tar.gz: OK</code>. It must also match the hash in the table above.</p></li>
        ${sigStep("linux")}
        <li><h3>Check where it was built</h3>${code(`gh attestation verify codeviewer-${VERSION}-linux-x64.tar.gz --repo ${REPO_SLUG}`)}<p class="note">Proves the file came out of this repository's release workflow at a specific commit, independently of this website.</p></li>
        <li><h3>Install</h3>${code(`tar -xzf codeviewer-${VERSION}-linux-x64.tar.gz\n./codeviewer/install.sh`)}<p class="note">Adds <code>codeviewer</code> to <code>~/.local/bin</code> and a desktop entry. The bundled browser is ungoogled-chromium, itself pinned by SHA-256 in the repository.</p></li>
      </ol>
    </div>
    <details class="more">
      <summary>Or build it yourself</summary>
      <p>You need <a href="https://bun.sh">Bun</a> 1.3.5 or newer (and Xcode command line tools for the Mac app). There are no dependencies to install.</p>
      ${code(`git clone ${REPO}.git\ncd codeviewer && git checkout v${VERSION}\nbun run test\nbun run build:local`)}
    </details>
  </section>
</main>

<footer class="foot">
  <div><img src="assets/favicon.svg" alt="" width="18" height="18"> Codeviewer</div>
  <div>MIT License · © ${new Date().getFullYear()} <a href="https://21no.de">21no.de</a> · <a href="${REPO}">Source</a> · <a href="${REPO}/blob/main/SECURITY.md">Security</a></div>
</footer>
</body>
</html>
`;

// ───────────────────────────── write ─────────────────────────────

await mkdir(path.join(out, "fonts"), { recursive: true });
await writeFile(path.join(out, "index.html"), html);
if (useRelease) await writeFile(RELEASE_JSON, JSON.stringify(release, null, 2) + "\n");
for (const f of ["SpaceGrotesk.woff2", "JetBrainsMono-Regular.woff2"]) await copyFile(path.join(root, "vendor/fonts", f), path.join(out, "fonts", f));
console.log(`site     docs/index.html (v${VERSION}: ${downloads.length - missing.length}/${downloads.length} downloads with checksums${signed ? ", signed" : ""})`);
