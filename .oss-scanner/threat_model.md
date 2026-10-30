# Threat model — codeviewer

`SECURITY.md` and `DESIGN.md` (§5, §8–§11) in this repository hold the maintained threat model; read them first.

## What this project does and where untrusted input enters
- Codeviewer is a read-only code viewer with a real built-in terminal (PTY), live git indicators, search and Markdown preview. It is a Bun server bound to `127.0.0.1` plus a window (or browser) locked to it, authenticated by a per-session token carried in the URL fragment and a request header.
- Untrusted: the **contents of every file viewed** (including Markdown, source code, file names, paths, git metadata such as branch names and commit messages, and `.git` config of the opened repository); any web page or local process that can reach `127.0.0.1` (other sites in the user's browser, other local users/processes) without the token; release metadata and downloads fetched by the in-app updater.
- Semi-trusted: shells started by codeviewer, which receive a narrower token that may only ask the viewer to open a file.
- Trusted: the local user at the window.

## Components that matter most / least
- Highest priority:
  - `src/server/http.ts`: token checks on every endpoint and WebSocket, Host/Origin checks (DNS rebinding, CSRF), CSP.
  - `src/server/pty.ts`: who can attach to or write to a terminal.
  - `src/server/files.ts` and `src/server/search.ts` / `search.worker.ts`: path containment (traversal, symlinks escaping the opened root).
  - `src/server/git.ts`: git invocation with repository-controlled config, argument injection.
  - `src/server/update.ts`: Ed25519 signature on `SHA256SUMS`, size caps, atomic swap.
  - Client Markdown pipeline (`src/client/markdown.ts`, `mdrender.ts`, `mdimage.ts`, `mdview.ts`): XSS, URL scheme allowlist, remote loads.
  - The narrow shell token's scope.
- Medium: `src/server/watch.ts`, `settings.ts`, `browser.ts`, client highlighting/diff/tree rendering of hostile file names and content.
- Out of scope: `docs/` site, `packaging/` scripts, `vendor/` third-party code (report only if reachable through codeviewer).

## How to exercise it
- `bun run test` (builds the client bundle, then `bun test`; see `test/http.security.test.ts`, `test/git.security.test.ts`, `test/markdown.fuzz.test.ts`).
- Server: `bun src/server/main.ts` after `bun scripts/build.ts --client-only`.

## How you rate severity
- Critical: a viewed file (or a malicious repository) causing command execution, terminal input, or token theft; a web page or another local user reaching the API/terminal without the token; the updater installing an unsigned binary.
- High: XSS in the viewer from file content or file names; reading files outside the opened root; the shell token doing anything beyond opening a file; any network access by codeviewer besides the update check.
- Medium: DoS from crafted files (rendering, search, highlighting, huge or deeply nested Markdown), information leaks of local paths to untrusted contexts.
- Low: hardening suggestions.

## Anything to leave alone
- What the user chooses to run in the built-in terminal; the terminal running commands is the feature.
