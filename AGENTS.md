# Working on Codeviewer

Guidance for coding agents (and people) changing this repository. Keep it short and true; update it
when the facts change.

## What this is

A read-only code viewer with a real terminal, written in TypeScript on Bun with **zero third-party
dependencies**. The server (`src/server`) serves one local page and a WebSocket per terminal; the
client (`src/client`) is vanilla TypeScript with a canvas terminal emulator, a virtualized code view,
a hand-written Markdown parser and a syntax highlighter. `packaging/macos/main.swift` is the native
Mac wrapper (AppKit + WebKit). The landing page is generated into `docs/` by `scripts/site.ts`.

## Commands

```sh
bun run test                      # builds the client, then runs the whole suite (the CI gate)
bun test test/foo.test.ts         # one file; add -t "name" for one test
bun scripts/build.ts --client-only
bun src/server/main.ts . --no-open --port 4573   # run the app against this repo; prints the URL (keep its #t= token)
bun run site                      # regenerate docs/index.html after editing scripts/site.ts
bun run shots [name…]             # retake landing page screenshots (macOS; shots in scripts/shots.list.ts)
bun run build:local               # binaries + the app for this machine (needs Xcode CLT on a Mac)
```

- There is **no typecheck step**: `tsconfig.json` has `types: []` and CI runs only `bun run test`.
  Verification is test-based; add or extend a test for every behaviour change.
- **Run one full suite at a time.** Two concurrent `bun test` runs make the watcher and git tests
  time out.
- Linux-only failures reproduce locally with Docker: `docker run --rm -v "$PWD":/app -w /app
  oven/bun:1.4.4 bun test test/pty.test.ts` (match the Bun version in `.github/workflows/ci.yml`).
- Swift changes: `xcrun swiftc -typecheck -target arm64-apple-macos13.3 -framework Cocoa -framework WebKit packaging/macos/main.swift`.

## Layout

| Path | What lives there |
| --- | --- |
| `src/server/http.ts` | Routes, auth (`tokenOk`, `authed`), CSP, WebSocket upgrades, the open-only terminal token |
| `src/server/git.ts` | Every git call; `neutralize()` builds the hardened environment |
| `src/server/pty.ts` | Terminal sessions (replay ring, backpressure, exit grace) |
| `src/server/search.ts` + `search.worker.ts` | Search in files (globs, the worker that opens files) |
| `src/server/update.ts` | Signed updater (host pinning, size caps, semver) |
| `src/client/app.ts` | App shell: layout, keyboard shortcuts, palette commands, toasts, help |
| `src/client/codeview.ts`, `mdview.ts`, `diffview.ts` | The three file views; each owns select-all and copy while visible |
| `src/client/term/` | Terminal emulator (`terminal.ts`), renderer, view (input, links, a11y log) |
| `src/client/tree.ts`, `search.ts`, `changes.ts`, `palette.ts` | Sidebar views and the palette (virtualized rows, `aria-activedescendant`); the palette's `pick()` lists anything (File History) and `@` lists symbols |
| `src/client/symbols.ts`, `reference.ts` | Go to Symbol patterns per language (pure); `path:line` references and their parsing |
| `src/client/styles.css` | All styling; colour tokens at the top, dark and light |
| `test/helpers/fakedom.ts`, `selfake.ts` | Minimal fake DOM for client tests (see limits below) |
| `scripts/shots.ts`, `shots.list.ts`, `demo-repo.ts` | Landing page screenshots: a deterministic demo repo, an isolated server, `packaging/macos/appshot.swift` driving an offscreen WKWebView |
| `DESIGN.md` | Architecture and every review round with findings and fixes |

## Rules that are easy to break

- **No dependencies.** Do not add packages, CDN scripts or vendored libraries. Fonts in
  `vendor/fonts` are the only third-party files.
- **Read-only.** Nothing may write to the viewed tree or the repository. Files open with
  `O_NOFOLLOW` after `realpath` containment (`resolveSafe`, `openRegular`); keep every new
  endpoint on that path.
- **Git hardening.** Overrides go through `GIT_CONFIG_KEY_n`/`VALUE_n`, never `-c key=value`
  (a driver named `a=b` splits at the first `=`). Any new git call goes through `Git.git()`.
- **Auth.** The session token lives in the URL fragment, sessionStorage and the `x-cv-token`
  header (`?t=` only for WebSockets). Terminals get the open-only token. Compare tokens with
  `tokenOk`. Never log a query, a path outside the root or a token.
- **Privacy.** The only outbound request is the update check (`src/server/update.ts`, GitHub
  hosts only). Adding another network call is a product decision, not a code change.
- **Untrusted content.** Markdown renders with `createElement`/`textContent` only; raw HTML is
  text, link schemes are allow-listed, remote images never load, and the CSP does not widen.
- **Images are blob: URLs.** They are fetched with the auth header and drawn from `blob:` URLs, so
  the Mac window's content rules allow `blob:http://127.0.0.1:<port>/` (`contentRules` in
  `main.swift`, pinned by `test/images.test.ts`). The server's `IMAGE_MIME` and the client's
  `IMAGE_EXT` (`mdimage.ts`) list the same extensions.
- **Terminal input is the user's.** On macOS ⌘-shortcuts belong to the app; on Linux Ctrl+key
  combinations stay with the shell unless the README lists them.

## Client conventions

- UI scale: `--ui-scale = codeSize / BASE_SIZE`, applied with CSS `zoom` on chrome containers.
  Inside a zoomed box use percentages, not `vh`/`vw` (WebKit scales viewport units too).
- Paint order: an in-flow sibling's text paints over a later sibling's background. Containers
  that can be squeezed (`.editor`) clip their overflow.
- Virtualized lists render rows as HTML strings with `data-i` first and `id` after it; tests match
  `class="…" data-i=`.
- Accessibility: keep `aria-activedescendant` on the scroller, stable row ids, `role="status"` for
  counts and `aria-live` regions for notifications. Respect `prefers-reduced-motion`.
- The fake DOM does not materialise `innerHTML` children, has no `clientHeight`,
  `getBoundingClientRect`, `insertAdjacentHTML` or selection API, and does not model native
  `Event` dispatch; stub what a test needs on the prototype and assert through the component's
  state.
- Visual checks on macOS: a `WKWebView` snapshot tool works headlessly if `requestAnimationFrame`
  is stubbed in a `WKUserScript` at document start and entrance animations are set to `none`.
  Snapshots write to the real settings file (tabs, zoom, panel): restore them afterwards.

## Docs to keep in sync

- `README.md`: features, the key table, Security and Privacy sections.
- `SECURITY.md`: anything that changes the threat model.
- `DESIGN.md`: a new round section with a findings → fixes table for every review or sizeable change.
- `scripts/site.ts` then `bun run site`: the landing page (`docs/index.html` is generated, do not
  edit it by hand). Its feature tour has one screenshot per feature: after a UI change, retake the
  affected ones with `bun run shots <name>` and read every image before committing (no real user
  name, host or path may appear; the demo repo and prompt are neutral).
- This file.

## Releasing

1. Merge to `main` (squash). 2. Bump `version` in `package.json`, commit `Release X.Y.Z` with a
one-paragraph summary. 3. `git tag vX.Y.Z && git push origin main --tags`. The release workflow
builds, signs `SHA256SUMS` and publishes; the landing page reads the release from GitHub at runtime.
