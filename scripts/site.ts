// Generates docs/index.html, the landing page served by Cloudflare at https://codeviewer.21no.de.
//
// The page carries no release data (no version, sizes or checksums baked in): docs/site.js reads
// the latest release from GitHub's API in the browser and fills in file names, sizes, SHA-256
// digests and the exact verification commands. Without JavaScript (or if the API is
// unreachable) every link falls back to the GitHub "latest release" page. Nothing goes stale,
// and nothing needs regenerating when a release is published.
//
//   bun run site
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const out = path.join(root, "docs");
const pkg = (await Bun.file(path.join(root, "package.json")).json()) as { repository: { url: string } };
const REPO = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""); // https://github.com/owner/name
const REPO_SLUG = REPO.replace("https://github.com/", "");
const LATEST = `${REPO}/releases/latest`;
const LATEST_DL = `${LATEST}/download`; // stable URLs for versionless assets (SHA256SUMS, .sig)
const KEY_URL = `${REPO.replace("github.com", "raw.githubusercontent.com")}/main/packaging/update-key.pub`;
const DOMAIN = "codeviewer.21no.de";
const SITE = `https://${DOMAIN}/`;

// Search and social metadata. The card image is docs/assets/og.png (bun run og).
const TITLE = "Codeviewer: a read-only code viewer with a built-in terminal for coding agents";
const DESCRIPTION =
  "Codeviewer is a fast, read-only code viewer with a real built-in terminal and live git indicators. Run Claude Code, Codex or aider and watch every file change, right next to the code. Private by design: no telemetry, nothing leaves your machine. Free and open source (MIT) for macOS and Linux.";
const OG_TITLE = "Codeviewer: read the code, run the agent, same window";
const OG_DESCRIPTION = "A fast, read-only code viewer with a real terminal and live git indicators. Watch your coding agent work, right next to the code. Free and open source.";
const OG_IMAGE = `${SITE}assets/og.png`;
const OG_IMAGE_ALT = "Codeviewer: Read the code. Run the agent. Same window. Next to a screenshot of the app with its file explorer, code view and terminal.";
// No version or file data here, for the same reason as the rest of the page (see above).
const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Codeviewer",
  description: DESCRIPTION,
  url: SITE,
  image: OG_IMAGE,
  screenshot: `${SITE}assets/screenshot-dark.jpg`,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux",
  license: "https://opensource.org/licenses/MIT",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  downloadUrl: LATEST,
  codeRepository: REPO,
  author: { "@type": "Organization", name: "21no.de", url: "https://21no.de" },
}).replace(/</g, "\\u003c");

/** A downloadable build, identified in the latest release by its file-name suffix. */
interface Platform {
  id: string;
  os: "macos" | "linux";
  label: string;
  detail: string;
  kind: "app" | "cli";
  prefix: string;
  suffix: string;
}

const PLATFORMS: Platform[] = [
  { id: "macos-arm64", os: "macos", label: "macOS", detail: "Apple silicon", kind: "app", prefix: "Codeviewer-", suffix: "-macos-arm64.dmg" },
  { id: "macos-x64", os: "macos", label: "macOS", detail: "Intel", kind: "app", prefix: "Codeviewer-", suffix: "-macos-x64.dmg" },
  { id: "linux-x64", os: "linux", label: "Linux", detail: "x86-64", kind: "app", prefix: "codeviewer-", suffix: "-linux-x64.tar.gz" },
  { id: "linux-arm64", os: "linux", label: "Linux", detail: "ARM64", kind: "app", prefix: "codeviewer-", suffix: "-linux-arm64.tar.gz" },
  { id: "cli-macos-arm64", os: "macos", label: "macOS CLI", detail: "Apple silicon", kind: "cli", prefix: "codeviewer-", suffix: "-macos-arm64" },
  { id: "cli-macos-x64", os: "macos", label: "macOS CLI", detail: "Intel", kind: "cli", prefix: "codeviewer-", suffix: "-macos-x64" },
  { id: "cli-linux-x64", os: "linux", label: "Linux CLI", detail: "x86-64 (glibc)", kind: "cli", prefix: "codeviewer-", suffix: "-linux-x64" },
  { id: "cli-linux-arm64", os: "linux", label: "Linux CLI", detail: "ARM64 (glibc)", kind: "cli", prefix: "codeviewer-", suffix: "-linux-arm64" },
  { id: "cli-linux-x64-musl", os: "linux", label: "Linux CLI", detail: "x86-64 (musl / Alpine)", kind: "cli", prefix: "codeviewer-", suffix: "-linux-x64-musl" },
];
const byId = new Map(PLATFORMS.map((p) => [p.id, p]));

// ───────────────────────────── helpers ─────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Generic name shown until (or unless) the latest release is known. */
const placeholder = (id: string) => `${byId.get(id)!.prefix}<version>${byId.get(id)!.suffix}`;

const ICON = {
  apple: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.7c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9s-2-.9-3.3-.9c-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8s2 .8 3.3.8c1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.8-1.1-2.8-4.1zM13.9 5.3c.7-.8 1.2-2 1-3.2-1 0-2.3.7-3 1.5-.7.7-1.2 1.9-1.1 3.1 1.2.1 2.4-.6 3.1-1.4z"/></svg>`,
  linux: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2c-2.2 0-3.6 1.9-3.6 4.6 0 1.4.3 2.3-.5 3.6-1 1.6-2.8 3.6-2.8 6.1 0 .9.2 1.6.6 2.1-.7.4-1.4.9-1.4 1.6 0 1.2 2 1.4 3.5 1.8 1.3.3 2.1.9 3 .9 1 0 1.6-.6 1.9-.6h.6c.3 0 .9.6 1.9.6.9 0 1.7-.6 3-.9 1.5-.4 3.5-.6 3.5-1.8 0-.7-.7-1.2-1.4-1.6.4-.5.6-1.2.6-2.1 0-2.5-1.8-4.5-2.8-6.1-.8-1.3-.5-2.2-.5-3.6C15.6 3.9 14.2 2 12 2zm-1.6 4.2c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zm3.2 0c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zM12 9.4c.9 0 2 .6 2 1s-1.1 1.1-2 1.1-2-.7-2-1.1 1.1-1 2-1z"/></svg>`,
  download: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  copy: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  check: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  github: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.6 0 0 3.6 0 8c0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8.6-.2 1.3-.3 2-.3s1.4.1 2 .3c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4C13.7 14.5 16 11.5 16 8c0-4.4-3.6-8-8-8z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

/**
 * A copyable command. Templates may use {url:ID}, {name:ID} and {tag}; site.js substitutes the
 * latest release's values. The static rendering shows generic placeholders.
 */
const code = (cmd: string) => {
  const shown = cmd
    .replace(/\{url:([\w-]+)\}/g, (_, id: string) => `${REPO}/releases/download/<tag>/${placeholder(id)}`)
    .replace(/\{name:([\w-]+)\}/g, (_, id: string) => placeholder(id))
    .replace(/\{tag\}/g, "<tag>");
  const lines = shown.split("\n");
  const tpl = cmd.includes("{") ? ` data-template="${esc(cmd)}"` : "";
  return `<div class="cmd"${tpl}><pre><code>${lines
    .map((l) => (l.startsWith("#") ? `<span class="c"># ${esc(l.slice(1).trim())}</span>` : esc(l)))
    .join("\n")}</code></pre><button class="copy" type="button" data-copy="${esc(lines.filter((l) => !l.startsWith("#")).join("\n"))}" aria-label="Copy command">${ICON.copy}</button></div>`;
};

/** An inline file name that becomes the latest release's real name. */
const fileName = (id: string) => `<code data-name="${id}">${esc(placeholder(id))}</code>`;

const FEATURES: [string, string, string][] = [
  ["terminal", "A real terminal, built in", "A native PTY and a from-scratch xterm-grade emulator: truecolor, mouse, alternate screen, bracketed paste and crisp box drawing. Run Claude Code, Codex, aider, vim or htop right next to the code, and hand the agent a <code>path:12-40</code> reference with one key."],
  ["live", "Live while agents work", "Files reload in place as they change on disk. Changed lines flash, the explorer marks them, and nothing you are reading jumps."],
  ["git", "Git, read-only", "Status letters in the explorer, gutter markers against HEAD with a peek at the old lines, inline blame, branch, ahead/behind and merge state, a Changes view that lists every file the branch touched as read-only diffs, and the history of any file, one commit at a time. It never writes to your repository."],
  ["fast", "Fast at any size", "Virtualized everything: 100k-line files open instantly, quick-open searches 200k paths as you type, and the terminal streams megabytes per second."],
  ["lock", "Locked down", "The window can only reach its own local server. Header-token auth, DNS-rebinding and CSRF guards, read-only file access with symlink containment, git hardened against hostile repositories and signed updates. Seven adversarial review rounds so far."],
  ["native", "Native and small", "A small native Mac app on the system WebKit, with real menus, window tabs and a folder picker. Built with Bun and TypeScript and zero third-party dependencies, so there is no supply chain to audit but this repository."],
];

const FEATURE_ICONS: Record<string, string> = {
  terminal: `<path d="M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4" />`,
  live: `<path d="M12 4a8 8 0 1 0 8 8M20 4v5h-5" />`,
  git: `<path d="M7 4v10M7 14a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17 9c0 4-10 3-10 5" />`,
  fast: `<path d="M13 3L5 14h6l-1 7 8-11h-6z" />`,
  lock: `<path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" />`,
  native: `<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 8.5h16M7 6.2h.01M9 6.2h.01" />`,
};

const row = (p: Platform) => `
        <tr data-asset="${p.id}">
          <td><div class="plat">${p.os === "macos" ? ICON.apple : ICON.linux}<span><b>${esc(p.label)}</b><small>${esc(p.detail)}</small></span></div></td>
          <td><div class="file"><a href="${LATEST}" data-link>${esc(placeholder(p.id))}</a><small data-size></small></div></td>
          <td class="hash"><span class="muted" data-hash>on GitHub</span></td>
        </tr>`;

/** Signature check (site.js hides it if the latest release has no SHA256SUMS.sig). */
const sigStep = (os: "macos" | "linux") =>
  `<li data-needs="SHA256SUMS.sig"><h3>Check the release signature</h3>${code(
    `curl -fsSLo codeviewer.pub ${KEY_URL}\nopenssl pkeyutl -verify -pubin -inkey codeviewer.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig`,
  )}<p class="note">Expect <code>Signature Verified Successfully</code>. Needs OpenSSL 3 or newer${os === "macos" ? " (<code>brew install openssl</code>; the built-in one is LibreSSL)" : ""}. This is the same Ed25519 signature the in-app updater checks before installing anything.</p></li>`;

const apps = PLATFORMS.filter((p) => p.kind === "app");
const clis = PLATFORMS.filter((p) => p.kind === "cli");

// ───────────────────────────── page ─────────────────────────────

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${esc(DESCRIPTION)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="author" content="21no.de">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0c0f15">
<link rel="canonical" href="${SITE}">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="assets/icon-256.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Codeviewer">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="${SITE}">
<meta property="og:title" content="${OG_TITLE}">
<meta property="og:description" content="${esc(OG_DESCRIPTION)}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(OG_IMAGE_ALT)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${OG_TITLE}">
<meta name="twitter:description" content="${esc(OG_DESCRIPTION)}">
<meta name="twitter:image" content="${OG_IMAGE}">
<meta name="twitter:image:alt" content="${esc(OG_IMAGE_ALT)}">
<script type="application/ld+json">${JSON_LD}</script>
<link rel="preload" href="fonts/SpaceGrotesk.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="site.css">
<script type="application/json" id="platforms">${JSON.stringify({ repo: REPO_SLUG, platforms: PLATFORMS.map(({ id, os, detail, suffix }) => ({ id, os, detail, suffix })) })}</script>
<script src="site.js" defer></script>
</head>
<body>
<header class="nav">
  <a class="brand" href="#top"><img src="assets/favicon.svg" alt="" width="22" height="22"><span>Codeviewer</span></a>
  <nav>
    <a href="#features">Features</a>
    <a href="#privacy">Privacy</a>
    <a href="#security">Security</a>
    <a href="#download">Download</a>
    <a class="gh" href="${REPO}" aria-label="Source on GitHub">${ICON.github}<span>GitHub</span></a>
  </nav>
</header>

<main id="top">
  <section class="hero">
    <p class="eyebrow"><span class="pill">Free</span> Open source · MIT licensed · No telemetry</p>
    <h1>Read the code.<br><span class="grad">Run the agent.</span> Same window.</h1>
    <p class="lede">Codeviewer is a fast, read-only code viewer with a real terminal built in. Point your favourite CLI agent at a project and watch every file it touches update live, with git telling you exactly what changed.</p>
    <div class="cta">
      <a class="btn primary" id="dl-primary" href="${LATEST}">${ICON.download}<span>Download for <b id="dl-os">macOS</b> <small id="dl-detail">Apple silicon</small></span></a>
      <a class="btn ghost" href="#download">All platforms</a>
    </div>
    <p class="fine"><a href="#verify">${ICON.shield} Verify your download</a> · SHA-256 and signed build provenance for every file</p>
    <figure class="shot">
      <picture>
        <source srcset="assets/screenshot-light.jpg" media="(prefers-color-scheme: light)">
        <img src="assets/screenshot-dark.jpg" width="2400" height="1508" alt="Codeviewer showing a project's explorer with git status letters, a TypeScript file with git gutter markers and inline blame, and a terminal running git log.">
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
      <p>Click any gutter marker to peek at the lines as they were in the last commit. Inline blame follows your cursor; the status bar shows the branch and how far ahead or behind you are. <kbd>⌘⇧G</kbd> opens the Changes view: everything the branch touched since it left <code>main</code>, or just what is uncommitted, each file one click from a read-only diff. Press <kbd>⌘/</kbd> for every shortcut; the whole app works from the keyboard and with a screen reader.</p>
      <ul class="ticks">
        <li>Explorer letters: <b class="gM">M</b> modified, <b class="gA">A</b> added, <b class="gU">U</b> untracked, <b class="gD">D</b> deleted, <b class="gC">C</b> conflict</li>
        <li>Live as you or an agent edit, stage, commit or switch branch</li>
        <li>Safe on untrusted repositories: no hooks, filters or drivers ever run</li>
      </ul>
    </div>
    <img class="shot-sm" src="assets/screenshot-light.jpg" width="2400" height="1508" alt="Light theme with a peek popup showing the HEAD version of a changed line." loading="lazy">
  </section>

  <section id="privacy" class="security">
    <h2>Private by design</h2>
    <p class="sub">Your code, your terminal and what you look at never leave your computer. There is no account, no cloud, no telemetry and no crash reporting: nothing to opt out of, because nothing is collected.</p>
    <div class="grid three">
      <article class="card"><h3>Local only</h3><p>Codeviewer is a small server on <code>127.0.0.1</code> and a window that can talk only to it. Settings live in one JSON file in your profile; no browser history, cookies or cache are kept.</p></article>
      <article class="card"><h3>One optional request</h3><p>The single outbound connection is a launch-time look at GitHub's releases API for a newer version. Switch it off with <b>Toggle Automatic Update Checks</b> or <code>CODEVIEWER_NO_UPDATE_CHECK=1</code> and the app never opens a socket to the internet.</p></article>
      <article class="card"><h3>Read-only, by construction</h3><p>It never writes to your files or your repository: files open read-only with symlink containment, git runs without hooks, filters or drivers and never touches the index. The terminal is yours; what you type there is the only way anything changes.</p></article>
    </div>
  </section>

  <section id="security" class="security">
    <h2>A shell in a window deserves care</h2>
    <p class="sub">Codeviewer serves a real terminal, so it was designed and then attacked by reviewers looking for a way in, seven rounds so far. Every confirmed finding was fixed and pinned with a test.</p>
    <div class="grid three">
      <article class="card"><h3>Only its own server</h3><p>The Mac window blocks every request except its own local port, with a strict Content-Security-Policy on top. External links open in your browser, never inside the app.</p></article>
      <article class="card"><h3>No ambient credentials</h3><p>A random 256-bit token lives in the URL fragment and a request header. No cookies, no token in process lists, Host and Origin checked on every request. Terminals get a narrower token that can only ask the viewer to open a file.</p></article>
      <article class="card"><h3>Hostile repos are fine</h3><p>Git runs without filters, textconv, signature checks, fsmonitor or submodules, and never writes your index. Read the <a href="${REPO}/blob/main/DESIGN.md">design and review notes</a>.</p></article>
      <article class="card"><h3>Signed updates</h3><p>The updater installs a release only when its <code>SHA256SUMS</code> carries a valid Ed25519 signature from the release key, downloads come from GitHub over https alone, and every file's SHA-256 is checked before an atomic swap.</p></article>
      <article class="card"><h3>Untrusted content stays text</h3><p>Markdown previews are built without <code>innerHTML</code>: raw HTML is shown as text, remote images never load, link schemes are allow-listed and the policy never widens for a file.</p></article>
      <article class="card"><h3>Built in the open</h3><p>Every release is built by GitHub Actions from a tagged commit with Sigstore provenance you can check yourself. <a href="#verify">Verify a download</a> in four commands, or build it from source.</p></article>
    </div>
  </section>

  <section id="download" class="download">
    <h2>Download</h2>
    <p class="sub"><span id="release-line">The latest release.</span> The apps are self-contained; the CLI binaries serve the viewer to any browser (<code>codeviewer . --no-open</code>).</p>
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
    <p class="fine">All files, <a href="${LATEST_DL}/SHA256SUMS">SHA256SUMS</a> and its <a href="${LATEST_DL}/SHA256SUMS.sig">signature</a> are on the <a href="${LATEST}">latest GitHub release</a>.</p>
  </section>

  <section id="verify" class="verify">
    <h2>Verify before you run it</h2>
    <p class="sub">Every release is built by <a href="${REPO}/blob/main/.github/workflows/release.yml">GitHub Actions</a> from a tagged commit, on a clean runner. Independent checks prove the file you have is that build: its checksum, the release signature, and where it was built.</p>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="true" data-tab="macos">macOS</button>
      <button role="tab" aria-selected="false" data-tab="linux">Linux</button>
    </div>
    <div class="panel" data-panel="macos">
      <ol class="steps">
        <li><h3>Download the app, the checksum list and its signature</h3>${code(`curl -LO {url:macos-arm64}\ncurl -LO ${LATEST_DL}/SHA256SUMS\ncurl -LO ${LATEST_DL}/SHA256SUMS.sig`)}<p class="note">Intel Mac: use ${fileName("macos-x64")}.</p></li>
        <li><h3>Check the SHA-256</h3>${code(`shasum -a 256 -c SHA256SUMS --ignore-missing`)}<p class="note">Expect ${fileName("macos-arm64")}<code>: OK</code>. It must also match the hash in the table above.</p></li>
        ${sigStep("macos")}
        <li><h3>Check where it was built</h3>${code(`# GitHub CLI: https://cli.github.com\ngh attestation verify {name:macos-arm64} --repo ${REPO_SLUG}`)}<p class="note">This checks a Sigstore-signed provenance statement logged in a public transparency log. It proves the file came out of this repository's release workflow, at a specific commit. It does not depend on this website.</p></li>
        <li><h3>Install</h3><p>Open the DMG and drag <b>Codeviewer</b> to <b>Applications</b>. The app is not notarized by Apple, so the first launch needs <b>right-click → Open</b>, or:</p>${code(`xattr -dr com.apple.quarantine /Applications/Codeviewer.app`)}</li>
      </ol>
    </div>
    <div class="panel" data-panel="linux" hidden>
      <ol class="steps">
        <li><h3>Download the package, the checksum list and its signature</h3>${code(`curl -LO {url:linux-x64}\ncurl -LO ${LATEST_DL}/SHA256SUMS\ncurl -LO ${LATEST_DL}/SHA256SUMS.sig`)}<p class="note">ARM64: use ${fileName("linux-arm64")}.</p></li>
        <li><h3>Check the SHA-256</h3>${code(`sha256sum -c SHA256SUMS --ignore-missing`)}<p class="note">Expect ${fileName("linux-x64")}<code>: OK</code>. It must also match the hash in the table above.</p></li>
        ${sigStep("linux")}
        <li><h3>Check where it was built</h3>${code(`gh attestation verify {name:linux-x64} --repo ${REPO_SLUG}`)}<p class="note">Proves the file came out of this repository's release workflow at a specific commit, independently of this website.</p></li>
        <li><h3>Install</h3>${code(`tar -xzf {name:linux-x64}\n./codeviewer/install.sh`)}<p class="note">Adds <code>codeviewer</code> to <code>~/.local/bin</code> and a desktop entry. The bundled browser is ungoogled-chromium, itself pinned by SHA-256 in the repository.</p></li>
      </ol>
    </div>
    <details class="more">
      <summary>Or build it yourself</summary>
      <p>You need <a href="https://bun.sh">Bun</a> 1.3.5 or newer (and Xcode command line tools for the Mac app). There are no dependencies to install.</p>
      ${code(`git clone ${REPO}.git\ncd codeviewer && git checkout {tag}\nbun run test\nbun run build:local`)}
    </details>
  </section>
</main>

<footer class="foot">
  <div><img src="assets/favicon.svg" alt="" width="18" height="18"> Codeviewer</div>
  <div>MIT License · © 2026 <a href="https://21no.de">21no.de</a> · <a href="${REPO}">Source</a> · <a href="${REPO}/blob/main/SECURITY.md">Security</a></div>
</footer>
</body>
</html>
`;

// ───────────────────────────── write ─────────────────────────────

await mkdir(path.join(out, "fonts"), { recursive: true });
await writeFile(path.join(out, "index.html"), html);
await writeFile(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`);
await writeFile(
  path.join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE}</loc></url>\n</urlset>\n`,
);
for (const f of ["SpaceGrotesk.woff2", "JetBrainsMono-Regular.woff2"]) await copyFile(path.join(root, "vendor/fonts", f), path.join(out, "fonts", f));
console.log("site     docs/index.html (release data is loaded live from GitHub)");
