# Codeviewer: Design Review by an Expert Panel

**Brief.** Build the most beautiful, fast, read-only IDE-style code viewer. It browses
directories and opens text files and images. It must include a real terminal so people
can run their favourite CLI harness (Claude Code, Codex, aider, vim, htop…) next to the
code. Use Bun + TypeScript only, with **zero third-party dependencies**, and ship binaries
for macOS and Linux.

Six panelists reviewed the brief. Each section below gives a panelist's position and the
decision the panel made. The final architecture is at the end.

---

## 1. Product & UX design (Interaction designer)

**Position.** People will spend most of their time in the terminal with an agent while it
edits code. The viewer is where they *watch* that work. So it has to:

- **Show changes live.** When a file changes on disk, the open tab reloads in place and
  keeps its scroll position. The changed lines get a short highlight. Tree entries that
  changed get a dot.
- **Make the terminal a first-class panel**, not an afterthought. It can sit at the bottom
  or on the right (for wide screens and agent workflows), can be maximized, and can hold
  several sessions as tabs.
- **Connect the terminal and the viewer.** ⌘/Ctrl-click a `path/to/file.ts:42` in the
  terminal to open it at that line. Running `codeviewer open <file>[:line]` inside the
  built-in terminal opens the file in the viewer, so an agent can show you what it means.
- **Be keyboard-first.** ⌘P quick-open (fuzzy), ⌘F find in file, ⌘G go to line, ⌃\`
  toggle terminal, ⌘B toggle sidebar, ⌘W close tab, ⌘⇧[ / ⌘⇧] switch tabs.

**Decision.** All of the above is in v1. Out of scope: editing (it's read-only by design),
git blame, LSP.

## 2. Visual design (Brand/visual designer)

**Position.** "Beautiful" means calm, dense and precise, not decoration.

- One carefully tuned dark theme ("Midnight") and one light theme ("Daylight"), chosen
  from `prefers-color-scheme` and switchable. All colors are CSS custom properties, so the
  terminal's ANSI palette, the syntax colors and the chrome come from one set of tokens.
- Use system UI fonts and system monospace fonts (SF Mono → JetBrains Mono → Cascadia →
  Menlo → DejaVu). No web fonts, so there's no network request and no flash of unstyled text.
- Use thin 1px hairlines, not heavy borders. Use 6px radii. Accent color only for focus
  and the active tab. File icons are hand-drawn compact SVG glyphs, tinted by language.
- Draw box-drawing and block characters in the terminal **procedurally**. Font glyphs
  leave gaps between cells, and that's what makes most web terminals look cheap.
  Rounded corners (╭╮╰╯), which agent TUIs use heavily, must look exact.
- Images get a checkerboard backdrop, fit-to-view / 1:1 / zoom, and a pixel-dimension
  readout.

**Decision.** Adopted. The terminal palette comes from theme tokens so the agent's colors
match the chrome.

## 3. Performance (Systems/performance engineer)

**Position.** Performance budgets: open a 100k-line file in under 100ms, keep scrolling at
60fps, keep the terminal smooth while it streams megabytes of output, and handle a repo of
200k files.

- **Code view:** virtualized. Only the visible lines (plus some overscan) are in the DOM,
  inside a fixed-height row model. Syntax highlighting is an **incremental, state-carrying
  line tokenizer**: the lexer state at the start of each line is cached, so highlighting
  line N costs O(lines since the last checkpoint), and only visible lines get tokenized.
  Files over 5 MB, or with lines over 20k characters, fall back to plain text.
- **Tree:** lazy-loads one directory at a time. The tree is flattened into a visible-rows
  array and rendered with the same virtualizer, so a folder with 50k entries stays fast.
- **Quick open:** the server walks the tree once in the background (skipping `.git`,
  `node_modules`, and other heavy directories, with a 200k-entry cap) and keeps it current
  from the watcher. Fuzzy scoring runs on the client against the cached list.
- **Terminal:** renders to a Canvas 2D context with **dirty-row tracking** and at most one
  frame per `requestAnimationFrame`. Text is drawn in runs of matching attributes, not
  cell by cell. PTY output arrives as binary WebSocket frames, gets parsed immediately,
  and is painted once per frame. The parser is a table-free switch state machine over
  code points with no regular expressions on the hot path.
- **Server:** serves embedded, pre-gzipped assets from memory, and serves raw files with
  `Bun.file` (zero-copy `sendfile`).

**Decision.** Adopted, with the budgets above.

## 4. Terminal emulation (Terminal-emulator specialist)

**Position.** Agent CLIs (Ink/React TUIs) and full-screen apps rely on a specific subset
of xterm. If any of it is missing, the UI breaks in subtle ways. Required:

- **PTY:** use Bun's native `Bun.spawn({ terminal })`, a real pseudo-terminal with
  `resize()`. This makes `isatty`, job control, `SIGWINCH` and Ctrl-C work properly.
  Without it nothing works, and Bun ≥ 1.3.5 provides it, so no `node-pty` is needed.
- **Parser:** VT500-style states (ground / escape / CSI / OSC / DCS-passthrough /
  string-ignore), streaming UTF-8 (`TextDecoder` with `stream: true`), C0/C1 controls.
- **Screen model:** primary + alternate screen (1049/1047/47), a scroll region
  (DECSTBM), scrollback (10k lines, configurable), autowrap with the pending-wrap flag
  (DECAWM semantics), origin mode, tab stops, insert mode, DECSC/DECRC, and reflow-free
  resize that keeps the cursor.
- **SGR:** bold, dim, italic, underline (plus curly/double, rendered as underline),
  blink (ignored), inverse, hidden, strikethrough, overline, 16/256/truecolor in both the
  `;` and `:` forms.
- **Modes:** DECCKM, bracketed paste (2004), focus events (1004), mouse
  1000/1002/1003 + SGR 1006, cursor visibility (25), DECSCUSR cursor shapes,
  synchronized output (2026, paints deferred until the end marker).
- **Reports:** DA1/DA2, DSR 5/6 (cursor position), OSC 10/11/4 color queries (agents use
  these to pick a light or dark palette), DECRQM for 2026, XTVERSION.
- **OSC:** 0/2 title (shown on the tab), OSC 8 hyperlinks (clickable), OSC 52 clipboard
  write (agents use it for "copy to clipboard"), OSC 7 cwd.
- **Width:** an East-Asian-wide and emoji width table (wcwidth-compatible), combining
  marks attached to the previous cell.
- **Input:** a hidden `<textarea>` captures keys, IME composition and paste. ⌥ acts as
  Meta on macOS. Shift+Enter sends `ESC CR` (the newline binding agents understand).
  Selection is by mouse drag, double-click selects a word and triple-click selects a line.
  ⌘C/⌘V on macOS, Ctrl+Shift+C/V on Linux.

**Decision.** Adopted in full. Kitty keyboard protocol and sixel/kitty graphics are
deferred: the app answers the kitty query with nothing, so clients fall back cleanly.

## 5. Security (Application security engineer)

**Position.** This app **serves a shell over HTTP**. Without care, any website the user
visits could open `ws://127.0.0.1:PORT/pty` and run commands (cross-site WebSocket
hijacking). Required:

- Bind to `127.0.0.1` by default. `--host` is an explicit opt-in and prints a warning.
- Generate a 256-bit random **session token** at startup. The launch URL carries it in the
  *fragment* (`/#t=…`), which browsers never send to servers. The page moves it into
  `sessionStorage` (isolated per origin, i.e. per port) and sends it on every request as an
  `x-cv-token` header; WebSocket upgrades carry it as a query parameter. **No cookies**: cookies
  are shared by every port on 127.0.0.1, so a cookie would leak to any other local server.
  *(Revised after the round-3 security review; the first design used a cookie.)*
- Validate the `Host` header on every request (127.0.0.1/localhost/[::1] plus our port), which
  defeats DNS rebinding. Writes must be `application/json`, which no cross-site form can send.
- Never put the token in a process's arguments (`ps` and `/proc` are readable by every user).
  Browsers are launched through a 0600 bootstrap page in a 0700 directory; macOS opens the
  default browser via `osascript` reading from stdin. Terminals get a separate token
  (`CODEVIEWER_TOKEN`) that only `/api/open` honours, so no process in a shell holds the
  session token.
- Check the **Origin** on WebSocket upgrades: it must match the (validated) server origin.
- Contain file access to the root. Resolve every path with `realpath` and check that it
  stays under the root's realpath, so symlinks can't escape. Reject `..`, NUL bytes and
  absolute paths. The viewer is read-only: no write endpoints exist at all.
- Serve all responses with a strict CSP (`default-src 'self'`, no inline script), plus
  `X-Content-Type-Options: nosniff`. SVGs are shown through `<img>`, never inlined, so
  scripts inside them can't run.

**Decision.** Adopted. These rules are non-negotiable.

## 6. Platform & build (Release engineer)

**Position.** Users should get one self-contained binary with no runtime to install.

- `bun build --compile` produces a single executable that embeds the client bundle, which
  is minified and pre-gzipped at build time.
- Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` (glibc), plus
  `linux-x64-musl` for Alpine.
- At launch the binary opens a **chromeless app window** when a Chromium-family browser is
  installed (`--app=URL`, which feels native, with no tabs or URL bar). Otherwise it falls
  back to `open` / `xdg-open`. `--no-open` is for headless/SSH use.
- The CLI is `codeviewer [dir] [--port N] [--host H] [--no-open] [--shell PATH]`, plus
  `codeviewer open <file[:line]>`, which talks to the running instance through env vars
  injected into its terminals.

**Decision.** Adopted.

---

## Final architecture

```
┌──────────────────────── single binary (bun --compile) ────────────────────────┐
│ server/                                                                       │
│   main.ts     CLI args, `open` subcommand, browser launch                      │
│   http.ts     Bun.serve: auth, CSP, static (embedded+gzip), REST, WebSockets   │
│   files.ts    safe path resolution, listing, text/binary sniffing, MIME       │
│   index.ts    background file index for quick-open                            │
│   search.ts   query compiler, matcher, candidate list; search.worker.ts scans │
│               files off the main thread (killable on timeout)                 │
│   watch.ts    recursive fs.watch → debounced change events                    │
│   pty.ts      Bun.spawn({terminal}) sessions ↔ WebSocket                     │
├────────────────────────────────── client/ (vanilla TS, bundled) ──────────────┤
│   app.ts        layout, splitters, keyboard, state                            │
│   tree.ts       lazy virtualized file tree                                    │
│   editor.ts     tabs; dispatches to code / image / binary views               │
│   codeview.ts   virtualized lines, gutter, find, go-to-line, change flash     │
│   highlight.ts  incremental multi-language tokenizer                          │
│   palette.ts    fuzzy quick-open                                              │
│   search.ts     sidebar search view: streamed, grouped results                │
│   keys.ts       pure shortcut and side-view helpers                           │
│   term/         terminal.ts (parser+screen), renderer.ts (canvas),            │
│                 input.ts (keys/mouse), width.ts, boxdraw.ts                   │
└───────────────────────────────────────────────────────────────────────────────┘
REST:  GET /api/info · /api/list?path · /api/file?path · /api/raw?path · /api/index · /api/search?q (NDJSON)
WS:    /ws/events   (fs changes, open-file requests)
       /ws/pty?id   (binary: pty bytes; text JSON: resize/input control)
```

---

# Round 2: Typography and the standalone runtime

Two follow-up questions went to the panel: *which fonts and sizes should be the defaults*, and
*how should codeviewer run as a self-contained desktop app on the fastest, most secure
open-source browser engine*. Three specialists joined: a **type designer**, a **reading-ergonomics
and accessibility specialist**, and a **browser-security engineer**.

## 7. Fonts (Type designer, Ergonomics specialist, Terminal renderer engineer)

**The problem with round 1.** System font stacks (`SF Mono → Menlo → DejaVu…`) give a different
face, width and x-height on every machine. Web pages can't use SF Mono by name, so macOS
actually fell back to Menlo. The terminal grid, the cell aspect ratio and how the code reads
changed with the host. A viewer whose job is reading needs a known, tuned typeface.

**Candidates considered (all OFL / open source):** JetBrains Mono, Iosevka, Fira Code,
Cascadia Code, IBM Plex Mono, Source Code Pro, Commit Mono, Geist Mono.

- **Type designer:** For code, choose **JetBrains Mono**. It has a tall x-height, so it stays
  legible at 12–14px. It has rectangular, open counters, and it clearly separates `0/O`, `1/l/I`
  and `rn/m`. It covers box-drawing and block elements, which matters for terminal fallbacks.
  Use the *static, hinted* instances (Regular, Bold, Italic, Bold Italic) rather than the
  variable font, because the hinted instances are crisper on 1× Linux displays. Iosevka is too
  narrow for long reading sessions. Fira Code and Cascadia are designed around ligatures. Plex
  Mono is beautiful but has a lower x-height and reads small.
- **Type designer:** For UI, choose **Inter** (variable). It was designed for screens at 11–14px,
  and it has optional glyphs that matter in a file explorer: `cv05` (l with tail) and `cv08` (I
  with serifs) make `Il1` unambiguous in file names. Use tabular figures (`tnum`) wherever
  numbers line up: the gutter and the status bar.
- **Ergonomics specialist:** **Ligatures off**, everywhere. A read-only viewer must show the
  exact characters on disk, and `!==` must not turn into a glyph. Code needs more leading than
  an editor because people scan it rather than type into it, so use **line-height 1.6**. The
  terminal needs the opposite: TUIs are laid out for about **1.2**, and box-drawing is drawn
  procedurally, so tight leading doesn't leave gaps.
- **Ergonomics specialist:** Base the size on **pixel density, not OS**. Use **13px** on HiDPI
  screens (device pixel ratio ≥ 2), where JetBrains Mono is designed to sit, and **14px** on 1×
  screens, where 13px loses stem contrast. UI text is 13px, and section labels are 11px with
  +0.08em tracking.
- **Terminal renderer engineer:** The terminal must **block until the fonts are loaded**. The
  cell grid is measured once, and measuring a fallback face gives wrong cell sizes.
  `font-display: block` applies to the mono face and `swap` to Inter. Glyphs that JetBrains Mono
  lacks (CJK, emoji) still fall back to system fonts, as before.

**Decision:** Embed JetBrains Mono 2.304 (4 static WOFF2s, about 380 KB) and Inter 4.1 (variable
WOFF2, 352 KB) in the binary, with their OFL licenses. No network access, and every machine
renders the same way.

| Surface | Face | Size | Line height |
| --- | --- | --- | --- |
| UI chrome | Inter, `cv05 cv08` | 13px (labels 11px) | 1.4 |
| Code | JetBrains Mono, no ligatures | 13px HiDPI / 14px 1× | 1.6 |
| Terminal | JetBrains Mono | 13px HiDPI / 14px 1× | 1.2 |

## 8. Standalone runtime (Browser-security engineer, Release engineer, Desktop-integration specialist)

**Requirement:** codeviewer is self-contained and runs as its own app, on the fastest and most
secure open-source browser engine. It depends on nothing installed on the machine.

| Option | Verdict |
| --- | --- |
| System WebView (WKWebView / WebKitGTK) | Not self-contained on Linux, and the engine differs per OS. Rejected. |
| Electron / Tauri | Third-party frameworks, which violates the zero-dependency rule. Rejected. |
| Firefox (Gecko) | Open source and solid, but it has no chromeless app-window mode (only kiosk), and its sandbox and site isolation are behind Chromium's. Rejected. |
| Chromium snapshots | Tip-of-tree development builds, not stable releases. Rejected. |
| **ungoogled-chromium (stable)** | Chromium's engine (V8, Blink, site isolation, seccomp-bpf and Seatbelt sandboxes) with Google services and telemetry removed. Current stable builds exist for macOS arm64/x64 (notarized with a Developer ID) and Linux x64/arm64. Each asset has a SHA-256 digest. **Chosen.** |

**Hardening (browser-security engineer):**
- **A throwaway profile per launch**, deleted on exit. Nothing persists in the browser: no
  cookies, cache or history. User settings move to the server
  (`~/.config/codeviewer/settings.json`), and the bundled browser has no other job.
- **Network containment:** `--host-resolver-rules` maps every hostname except `127.0.0.1` to
  NOTFOUND, and `--no-proxy-server` disables proxies. The app window can only reach its own
  server. External links (⌘-click a URL in the terminal) are handed to the user's *default*
  browser by the server, which only accepts `http(s)` URLs.
- **Attack surface off:** no extensions, sync, background networking, component updates,
  default apps, first-run, translate or media router. **The sandbox is never disabled.**
- **Integrity:** the build downloads a release and refuses it unless its SHA-256 matches the
  digest published with the release. By default the build takes the *latest* stable release,
  because a bundled browser that goes stale is a security liability. You can pin a version
  with `--browser <tag>`.

**Desktop integration:**
- macOS: a `Codeviewer.app` bundle with the notarized Chromium inside. Launching it from Finder
  shows the native folder picker.
- Linux: a `.tar.gz` with the binary, the browser and a `.desktop` entry.
- Closing the window quits the app: the server stops and the PTYs are killed. Running from a
  terminal works as before (`codeviewer [dir]`). The slim browser-less binaries are still
  built, for headless/SSH use (`--no-open`) or for people who prefer their own browser.

**Trade-off accepted:** each app download gains about 150 MB for the browser. That's the price
of being self-contained and pinned to a verified engine.

## 9. Addendum: macOS uses the system WebKit, delivered as a DMG

**New requirement:** on macOS, install from a `.dmg`, and skip bundling Chromium if possible.

**Panel re-vote (browser-security engineer, desktop-integration specialist, release engineer):**
WebKit is open source and ships *inside macOS* as `WebKit.framework`. Apple patches it through OS
security updates, so a bundled engine can't go stale. WebKit also runs page content in a
separate, sandboxed WebContent process. A ~250-line native AppKit shell (`packaging/macos/main.swift`,
using only system frameworks) gives a true Mac app: Dock icon, menus, native tabs,
drag-a-folder-onto-the-Dock, the folder picker and the window title proxy icon. The DMG drops from
~190 MB to **~40 MB**. Chromium stays the bundled engine on Linux, which has no system web engine
we can rely on.

**Hardening carried over from §8:**
- A non-persistent `WKWebsiteDataStore`: nothing survives the window.
- A compiled `WKContentRuleList` that blocks every request except `http/ws://127.0.0.1`.
- A navigation delegate that only allows loopback. Any other URL, and every `window.open`, goes to the default browser.
- App Transport Security allows only local networking.
- The bundle is sealed with an ad-hoc code signature.

**Lifecycle:**
- Each window owns one server process (`--machine` prints its URL as JSON), and closing the window stops it.
- `--exit-with-parent` makes the server exit if the app dies.
- `codeviewer <dir>` in a terminal hands the folder to `Codeviewer.app` (`open -n -a … --args --folder`).
- **Codeviewer → Install 'codeviewer' Command…** symlinks the bundled CLI into `/usr/local/bin`.

## 10. Git indicators (read-only)

The server reads git state through the system `git` CLI. A reimplementation would mean
supporting packfiles, the index format and worktrees, and every one of those is a place to
get it wrong. Every call is hardened:
- `GIT_OPTIONAL_LOCKS=0`: never writes the index or takes locks.
- `core.fsmonitor=false`: never runs a hook the repository configures.
- `diff.external=` is empty, `cat-file blob` reads raw blobs, and nothing uses textconv or filters.
- No prompts or pager. Arguments are passed as arrays.

Status is `git status --porcelain=v2 -z --ignored` scoped to the viewed folder (which can be a
subfolder of the repo). It refreshes 200 ms after worktree changes or after changes to `.git`
(index, HEAD, refs, merge/rebase files) and is pushed over the events socket only when it differs.

Gutter markers come from a client-side Myers line diff of the buffer against `HEAD`. Common
prefixes and suffixes are trimmed first, and a pathological middle section is capped at 2,000
edits, so a 100k-line file diffs in milliseconds. Blame runs `git blame --porcelain -L n,n` for the
active line only.

## 11. Round 3: adversarial reviews (security, performance, correctness)

Three independent reviewers attacked the code and backed each finding with a repro or a
measurement. Every confirmed finding was fixed and, where possible, locked in with a test:

| Area | Finding | Fix |
| --- | --- | --- |
| Security (critical) | A malicious repo's `.git/config` + `.gitattributes` ran programs through filters, textconv and gpg | `GIT_ATTR_SOURCE` = empty tree, every configured driver blanked, no signatures/textconv/submodules; regression test with a control run |
| Security (high) | Token visible to other users in the browser's argv | 0600 bootstrap page; `osascript` via stdin |
| Security (medium) | Cookies leak across 127.0.0.1 ports; `text/plain` CSRF; no `Host` check | Header auth, no cookies; JSON-only writes; `Host` validation |
| Security (medium) | A FIFO in the tree hung file serving | `O_NOFOLLOW` and `O_NONBLOCK` opens, regular files only |
| Security (low) | Silent OSC 52 clipboard writes; macOS shell failed open; browser download not pinned | Toast on every write and none during replay; per-port rule lists that fail closed; `browser-pins.json` |
| Correctness | Bracketed-paste end marker could be rebuilt by nesting it | Strip every ESC/C1 from pasted text |
| Correctness | Replay after a reload lost alt screen, paste and mouse modes | Each replay chunk carries the mode prefix in effect before it; replay starts at a line boundary |
| Correctness | Emulator edge cases | Fixed: ZWJ emoji, BS with pending wrap, unterminated OSC/DCS, CAN/SUB, C1, CNL/CPL margins, EL wrap, wide-char erase, 1049 charsets, DECRC after resize, DECSTR, DECXCPR |
| Correctness | Regex literals broke JS highlighting; multi-dot file links; staged-new-file gutter; UTF-16; NFD names; Option key on non-QWERTY layouts; reload races | Fixed |
| Performance | One WebSocket frame per PTY read (298k frames for 52 MB) and no backpressure | Coalesced 4 ms/64 KB frames; high-water mark with a resync on drain |
| Performance | Line allocation per scroll; scrollback at 4.6 KB/line | Lines recycled, cleared only up to a write high-water mark; history compacted. `yes` 9.3 → 13 MB/s, memory −62% |
| Performance | Per-keystroke and per-frame linear work | Quick-open narrowing + top-k; O(depth) git lookups; ASCII natural sort; incremental file index; adaptive git debounce; render windows in the tree and code view; glyph-width cache |

## 12. Updates

Users update from inside the app ("Check for Updates…", or the status-bar pill). A self-updater
is a remote-code-execution channel by design, so it gets the same treatment as the terminal:

- **Authenticity, not just integrity.** The release workflow signs `SHA256SUMS` with an
  Ed25519 key that exists only as an Actions secret (`CODEVIEWER_UPDATE_KEY`). Every build
  embeds the public key (`packaging/update-key.pub`). Before anything is installed, the
  updater checks four things:
  1. The signature is valid, so a compromised download host or a swapped release asset is
     rejected.
  2. The downloaded file's SHA-256 matches its line in the signed list.
  3. The signed file name carries the new version.
  4. The version is strictly newer, so no rollbacks.
  
  On macOS the staged app must also pass `codesign --verify --deep --strict`. Verification uses
  WebCrypto, so it adds no dependencies.
- **Atomic, with rollback.** Updates are staged next to the target, on the same file system,
  and swapped in with `rename`: the `.app` bundle, the Linux package directory, or the CLI
  binary. If the swap fails, the old copy is put back. Nothing new runs until verification passes.
- **Restart.** The Mac shell reopens every window's folder in the new version. The Linux app
  window starts the new binary and closes itself. CLI users are told to restart. Running from
  source is never auto-updated (`git pull`).
- **Privacy.** One request to `api.github.com` per launch, which can be turned off (setting, or
  `CODEVIEWER_NO_UPDATE_CHECK=1`).
- **Tests** run the real updater against a fake GitHub:
  - Successful installs of the CLI, the Linux package and a real code-signed DMG.
  - Rejection of a forged signature, a checksum mismatch, a rollback, an unsigned release, a
    missing key, and a tampered app bundle. In each case the installed copy must stay untouched.

## 13. Round 4: Search in files

**Brief.** Add project-wide content search. Four panelists reviewed it: the interaction designer,
the systems/performance engineer, the application security engineer, and the frontend
architect & test lead. Before this, the app had only ⌘P (fuzzy file names) and ⌘F (the open file).

### Positions and decisions

**Where it lives (interaction designer).** Search is a second sidebar view next to the
Explorer. It is not a palette mode, because the palette closes when you act and search results
need to stay visible while the agent works. It is not a panel either, because the terminal owns
that slot.
- ⌘⇧F (Ctrl+Shift+F) shows the sidebar, switches to Search, and focuses and selects the query.
  It works from the terminal too.
- The existing `mod && k === "f"` branch in `app.ts` ignores Shift, so the new branch must come
  first and the old one gets `!e.shiftKey`.
- The current sidebar view is saved in layout state (`L.sideView`).
- **Decision: adopted.**

**Query options.** Search uses the same three toggles as the find bar: Aa (match case),
ab (whole word) and .* (regex), with the same labels and `aria-pressed`. Matching uses the same
rules as `codeview.ts`, so a hit in the project is a hit in the file.
- There are optional include and exclude globs, comma-separated, matched with `Bun.Glob`.
- Deferred: replace (never; the app is read-only), multiline regex, search history.
- **Search in Folder…** (folder context menu in the Explorer) switches to Search and sets the
  include field to `<folder>/**`, re-running any current query. Glob metacharacters, commas and
  whitespace in the folder name are backslash-escaped, so the scope stays literal: `parseGlobs`
  treats `\,` as a literal comma (not a separator) and the client's trim cannot eat edge whitespace.
  The scope is set before the view is revealed, so exactly one request is made. A git-ignored folder
  turns "Include ignored files" on. An existing exclude is kept (user-authored filter), so an exclude
  that covers the folder yields no results. A scope longer than the server's 1,024-character cap shows
  a message instead of an invalid-query error.

**Engine (performance engineer).** Matching runs in the server, in a Bun `Worker`, using sync
I/O into a buffer that is reused.
- Measured on a corpus of 68k files and 360 MB:
  - One worker took 1.5 s and two took 0.89 s. The first hit arrived in 2 ms.
  - `rg -uuu` took 2.3–3.1 s.
  - Literal and regex searches cost the same, because the time goes to I/O.
- `rg` was rejected: it isn't installed everywhere, and the app has a zero-dependency rule.
- `git grep` was rejected for matching:
  - It only works inside a git repo.
  - It uses POSIX/PCRE regex instead of JS regex, so its results would disagree with the
    highlights in the client.
  - It brings in more git attack surface.
- **Decision:** v1 uses one worker. A pool of two is a planned improvement if a 200k-file scan
  misses its budget.
- The worker also serves as the kill switch for runaway regexes.

**Candidate files.**
- In a git repo: `git ls-files -z --cached --others --exclude-standard --deduplicate -- .`,
  run through the hardened git runner, so `.gitignore` is respected without writing a parser.
  The list is cached and invalidated on watcher batches.
- Outside a repo, or with "Include ignored files" on: the `FileIndex` list. That list still
  skips `HEAVY_DIRS`.

**Matching rules.** The query compiles to one JS `RegExp` (`g`, `u`, plus `i` when case-insensitive).
- Literal queries are escaped.
- Whole word uses the find bar's rule.
- A case-sensitive literal search first checks the raw bytes with `Buffer.indexOf`, so most
  files are never decoded.
- Decoding follows `readForView`: strip the UTF-8 BOM, transcode UTF-16 with a BOM, and use
  U+FFFD for invalid bytes.
- Lines split on `\r\n|\r|\n`, the same as the client, so line numbers agree.
- Columns are UTF-16 offsets.
- Zero-length matches advance and are dropped.
- A match that spans lines is clipped to its first line.

**Security (application security engineer).** Non-negotiable:
- The user's pattern never runs on the main thread, which carries the PTYs.
  - The main thread enforces a 10 s wall-clock deadline and also cancels when `req.signal`
    aborts.
  - It cancels by setting a cancel flag, then calling `worker.terminate()` if the worker
    doesn't stop.
  - A test must prove that `terminate()` stops `/(a+)+$/` running on `"a".repeat(40)+"b"`.
- Only one search runs per server: the newest wins and cancels the old one.
- Limits:
  - The query is at most 256 UTF-16 units, with no control characters.
  - The response stops at 2,000 matches in total, then reports `truncated`.
  - At most 100 matches per file, followed by a `more` count.
  - Files over `MAX_TEXT_BYTES` and binary files (`looksBinary`) are skipped and counted.
  - Previews show about 200 characters around the match.
- Every candidate file is re-opened with `O_NOFOLLOW|O_NONBLOCK`, and the code checks that it is
  a regular file from `fstat`. `FileIndex` lists symlinked files, so a link to `~/.ssh/id_rsa`
  must not be read. Files are de-duplicated by `dev:ino`.
- Per-file errors are swallowed and counted in `skipped`. Top-level errors return fixed
  strings, never `e.message`, because that can contain absolute paths. Queries are never logged.
- Client: paths and previews come from the repo, so they are untrusted.
  - Every slice is escaped with `esc()`, and only the match is wrapped in `<mark>`.
  - Rows are referenced by `data-i`, and paths never go into attributes.
  - C0/C1 controls and bidi overrides are shown as visible escapes, against Trojan Source.
- `git grep`, if it is ever added, must use `-e`, `-F`/`-E`, `--no-textconv`,
  `GIT_LITERAL_PATHSPECS=1`, a kill timer and `--`.

**API (frontend architect).** `GET /api/search?q=&regex=1&case=1&word=1&include=&exclude=&ignored=1`
returns `400 {error}` for an empty query, a query that is too long, or an invalid regex.
Otherwise it returns `200 application/x-ndjson`:
```ts
interface SearchMatch { line: number; col: number; len: number; preview: string; pcol: number }
type SearchEvent =
  | { t: "file"; path: string; matches: SearchMatch[]; more?: number }
  | { t: "done"; files: number; matches: number; skipped: number; truncated: false | "matches" | "time"; ms: number; error?: true };
```
If the scanner fails after output has started, the stream still ends with a `done` line carrying
`error: true` (no message).
The search does not use `/ws/events`: that socket broadcasts to everyone and can't cancel a
single request.

**Results UI.**
- Results are grouped by file, and each group can be collapsed. A file header shows its icon,
  name, dimmed folder and match count.
- Each line row shows the line number in tabular figures and a preview that starts about 30
  characters before the match with "…". Matches are wrapped in `<mark>`, and the selected one in
  `mark.cur`.
- A summary line reads "312 results in 41 files", and the honest-cap banner reads
  "Showing first 2,000 results".
- No virtualization in v1: the 2,000-match cap bounds the DOM.
- Keyboard:
  - ↑/↓ move the selection.
  - Enter opens the result in the preview tab and keeps focus in the list.
  - Esc in the list returns to the query; Esc in the query clears it.
  - F4 / ⇧F4 move to the next or previous result from anywhere except the terminal.
- Live search runs as you type: after a 250 ms debounce, at 2 or more characters (1 for regex).
  Enter runs it immediately. Each new search aborts the previous fetch through
  `AbortController` plus a generation counter.

**Opening a result.**
- `openFile(path, {line, col, len})` goes through `editor.open` and then `CodeView.showRange`.
- `showRange` marks the match as the current mark and scrolls it into view horizontally,
  sharing `revealCol` with the find bar.
- The marking logic is factored into a pure `markRanges` so it can be unit-tested.

**Live changes.**
- When a `changed` event touches a path that is in the results (or reports `many`), a "Results may
  be out of date · Refresh" bar appears. Refresh re-runs the query. If the Search view is hidden,
  the results are marked stale and refreshed when it is shown again.
- **Deferred:** re-searching only the changed paths in place.

**States.**
- Empty query: a hint with the shortcuts.
- Searching: a thin progress bar after 150 ms.
- No results: "No results for …".
- Invalid regex: the input turns red and shows the message, as in the find bar.
- Skipped files: "N binary/large files skipped".

### Slices (built test-first)
1. Pure matcher `src/server/search.ts`: `compileQuery`, `matchText` (lines, cols, previews, caps).
2. Scanner + Worker + `GET /api/search` NDJSON endpoint, with containment, binary/large skips, caps, cancel and the regex-DoS kill.
3. Candidate list: `git ls-files` in repos, `FileIndex` otherwise, include/exclude globs, ignored toggle.
4. Client `api.search` + NDJSON splitter + `SearchView`: grouped results, summary, truncation, errors, abort.
5. App wiring: sidebar Explorer/Search switch, ⌘⇧F, commands, open result at line/col with `showRange` highlight, F4/⇧F4, keyboard nav.
6. Staleness bar on `changed` events; docs (README shortcut table, DESIGN.md architecture/REST list).

### As built

- **Anchors.** The worker adds the `m` flag, so `^` and `$` match at every line, the same as the
  client find bar, which tests one line at a time.
- **Containment.** Each candidate's `realpath` is checked inside the worker; a path that resolves
  outside the root counts as skipped, as do binary, oversized and non-regular files.
- **Caps.** `include` and `exclude` are limited to 1,024 characters and 64 patterns each (400
  otherwise).
- **Collapsed groups.** Keyboard navigation follows the VS Code convention: ↑/↓ skip the rows of
  a collapsed group, and F4 / ⇧F4 expand the group they land in.
- **Coverage.** The worker (`search.worker.ts`), the build script, `app.ts` and `editor.ts` are
  excluded from line coverage: they run in a separate thread, the bundler or the real DOM, and are
  exercised through the endpoint, build and manual runs instead.

## 14. Round 5: Markdown rendering

**Brief.** Render `.md` and `.markdown` files as formatted documents, with the source one click away, no external
dependencies of any kind (the parser and renderer are written in this repo), and repo content treated as untrusted.
Four panelists reviewed it: the interaction designer, the application security engineer, the systems/performance
engineer, and the frontend architect & test lead. Before this, a Markdown file opened as highlighted source.

### Positions and decisions

**Preview and source (interaction designer).** A text tab for a Markdown file opens as a rendered preview. The
existing `tab.asSource` flag and `viewToggle` button, which already switch an SVG between image and source, are reused:
"View source" in preview, "Preview" in source, same button and position. There is no second tab for the same path.
- Opening with a line (search hit, `file:line`, `:` in the palette, Go to line) forces source view, because a line has
  no meaning in the preview. Find (⌘F) in the preview switches that tab to source and opens the find bar there, so it
  never falls through to the browser's find silently.
- The mode is per tab and survives live reloads: a file edited on disk while in source stays in source.
- A palette command "Toggle Markdown Preview" is added.
- Prose uses the system UI font with a centred column of about 78ch; code uses the existing mono font. All colours come
  from the existing theme tokens. Headings h1/h2 have a hairline underline; tables have hairline borders; task-list
  checkboxes are disabled, because the product is read-only. Text size follows the zoom.
- Deferred: an "On this page" outline, a Cmd/Ctrl+Shift+V shortcut, find inside the preview, link hover in the status
  bar, copy button on fences, flashing changed blocks, persisting the mode across restarts.
- **Decision: adopted** (except the deferred items above).

**Escaping model (application security engineer).** Script execution in the page equals shell access, so the escaping
model is the primary defence and the CSP is the backstop. The CSP is not loosened.
- The renderer builds DOM with `createElement` and `textContent` only. It never uses `innerHTML` and never the `html:`
  prop of `h`. The security engineer first proposed a string renderer with one `innerHTML`; the performance engineer
  and the architect argued for DOM building (no escaping-bug class, nodes can be replaced individually, and the fake
  DOM in tests cannot inspect `innerHTML`). The security engineer accepted, on the condition that a test walks the
  output tree and fails on any tag outside a closed set (p, h1-6, ul/ol/li, blockquote, pre/code, table family, a,
  img, em, strong, del, hr, br, span with a `tok-*` class, input checkbox disabled), any `on*`, `style`, `srcdoc`
  or `name` attribute, and any `id` that is not `md-` prefixed.
- Raw HTML (inline and blocks, comments included) is shown as literal text, never parsed. No allowlist in v1.
- Link URLs go through one pure function, `safeHref`. Allowed: `http:`, `https:`, `mailto:`, `#fragment` and relative
  paths. Everything else (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, unknown schemes, protocol-relative
  `//host`, backslashes) is rendered as its label text with no `<a>`. The URL is probed after stripping control, space
  and zero-width characters and decoding entities, so `java\tscript:` and `&#x6A;avascript:` are caught.
- External links get `rel="noopener noreferrer nofollow"` and `target="_blank"`. Relative links never navigate: a
  delegated click handler resolves the path against the document's folder (collapsing `.` and `..`, percent-decoding
  once, rejecting anything that escapes the root) and opens it through the editor. The server's `resolveSafe` stays the
  real boundary. `#fragment` clicks scroll inside the preview and never touch `location.hash`; heading ids use an
  `md-` prefix, to avoid DOM clobbering.
- Relative images load only through `api.rawBlobUrl`, into an `<img>` with a blob URL (SVG is script-inert there and is
  never inlined). The extension must be an image type the server serves, so `![](.env)` is never fetched. Blob URLs are
  revoked on re-render and on close. At most 100 images per render.
- Remote images (`http(s)`, `//host`, `data:`) never load. The CSP already blocks them and `img-src` is not widened, so
  consent loading is impossible without relaxing it. The renderer shows a placeholder with the alt text and the host,
  and a link to open the URL in a new tab on an explicit click. A per-image "load" action is deferred until a CSP
  decision is made. The interaction designer wanted consent loading; the security and performance engineers wanted
  none in v1; the architect noted the CSP forces "none".
- Trojan Source: code spans, code blocks and link titles show C0/C1 controls and bidi overrides as visible escapes,
  reusing the `HIDDEN` rule that now lives in `util.ts` (moved from `search.ts`). Blocks get `dir="auto"`. The fence
  info string is only a lookup key (`[a-z0-9+#-]{1,20}`, mapped to a known language), never emitted into an attribute.
- **Decision: adopted.**

**Parser and limits (performance engineer).** Rendering is client-side from the text already fetched. No server change
and no new endpoint.
- The parse is linear: a line-oriented block pass with an explicit container stack (no recursion), and a
  CommonMark-style delimiter stack for emphasis. No regex with nested quantifiers touches untrusted text.
- Hard limits degrade to literal text and never throw: container nesting 32, inline nesting 32, 10,000 link
  definitions, 200 table columns, 10,000 characters per inline line, about 200,000 rendered nodes. Tests run the
  adversarial corpus (200k `*`, 100k `[`, 100k `> `, 100k `- `, 1e5 backticks, `![](` chains, a 1 MB single line)
  with generous time bounds, and check that doubling the input does not more than triple the time.
- Files over 1 MiB open in source with a "Too large to preview · Render anyway" note. The panel proposed 2 MiB
  (performance) and 1 MiB (designer, architect, security); the lower cap won, because there is no chunked rendering.
  A truncated file (`x-cv-truncated`) shows the existing truncation pill above the preview.
- Fenced code highlights with `lexLine` from `highlight.ts`, threading its state line by line. The stateful per-file
  `Highlighter` is not used. Fences over 2,000 lines or 200 KB render as plain text. The architect and the performance
  engineer differed on `Highlighter` versus `lexLine`; `lexLine` won because it needs no file-wide state.
- A live update re-parses (cheap and linear), builds the new tree off-screen, swaps it with `replaceChildren` in one
  frame, and restores `scrollTop`. Identical text skips the render. A reload while in source mode does not render the
  preview; it is rendered when shown. Closing a tab drops the tree and the parsed blocks.
- Deferred: chunked/idle rendering, incremental node reuse, a parsing worker, lazy highlighting by visibility,
  `content-visibility`. The 1 MiB cap and the node cap bound the cost until measurements say otherwise.
- **Decision: adopted** (chunked rendering and node reuse deferred).

**Structure and tests (frontend architect & test lead).** Three modules with hard boundaries:
- `src/client/markdown.ts` is pure: `parseMarkdown(src)` returns a typed AST; it also exports `isMarkdown`,
  `safeHref`, `resolveRepoPath` and `slugify` (GitHub-style, de-duplicated with `-1`, `-2`). It has no DOM and no
  imports besides types, so its tests run without the fake DOM.
- `src/client/mdrender.ts` turns the AST into DOM and `src/client/mdview.ts` is `MarkdownView { el, setText, dispose }`,
  mirroring `CodeView.setText`. `editor.ts` gets `md?: MarkdownView` on `Tab` and a guard on every `tab.code`
  consumer (status, go to line, find, git refresh, font size).
- Syntax: CommonMark core (ATX/setext headings, paragraphs, fenced and indented code, nested block quotes, nested and
  loose/tight lists, thematic break, link reference definitions, emphasis, code spans, links, images, autolinks,
  escapes, hard breaks, a small entity table decoded to text) plus GFM (tables with alignment, task lists,
  strikethrough, bare URL autolinks). Not supported in v1: raw HTML, footnotes, math, diagrams, front matter. Full
  CommonMark conformance is not a goal; correctness is pinned by hand-written cases in `test/fixtures/` (authored in
  this repo, not copied from the spec) plus a seeded fuzz test that checks the safety invariants on 2,000 random inputs.
- `editor.ts` and `app.ts` cannot be loaded under the fake DOM, so they are excluded from line coverage, as in Round 4.
  Everything with logic lives in the three modules above, which are covered.
- **Decision: adopted.**

### Slices (built test-first)
1. `markdown.ts` core + `MarkdownView` + editor wiring: headings, paragraphs, source/preview toggle, live update with
   scroll kept, `tab.code` guards, `file:line` forces source, find and Go to line switch to source. DESIGN.md section.
2. Block and inline core: lists, quotes, code blocks, thematic break, emphasis, code spans, escapes, entities, hard
   breaks, caps and the adversarial perf corpus.
3. Links: `safeHref`, `resolveRepoPath`, external and repo-relative links, `#fragment` scrolling, heading slugs, autolinks.
4. GFM: tables, task lists, strikethrough; theme styles in `styles.css`.
5. Fenced code with `lexLine` highlighting, size caps, info-string allowlist.
6. Images (relative via blob, remote placeholder), size gate with "Render anyway", palette command, README and
   SECURITY notes, fuzz test.

## 15. Round 6: Branch changes review

**Brief.** Let the user review what an agent changed: both the uncommitted work and everything the
branch has accumulated since it left its base branch, since agents commit every few minutes. Three
panelists reviewed a draft: the interaction designer, the visual/information designer, and a
developer-experience researcher who argued for the smallest product that does the job. Before this,
the app had gutter markers vs `HEAD` with click-to-peek, and ⌘⇧G opened a palette list of changed
files (a binding that, it turned out, was advertised but never wired).

### Positions and decisions

**Where it lives (all three).** A third sidebar view, "Changes", next to Explorer and Search, for the
reason Search is one (§13): the list must stay visible and keep updating while the agent works, and a
palette closes when you act. Not a panel (the terminal owns it), not a tab (it would fight the file
being read).
- ⌘⇧G shows the sidebar, switches to Changes and focuses the list. The status bar's branch and
  change-count buttons do the same. The palette list is gone: two surfaces for one list is a
  discoverability and maintenance tax.
- **Decision: adopted.**

**Scope (disagreement, resolved).** The interaction designer wanted a single list, branch vs base,
falling back to `HEAD`, because a switch makes the user choose before seeing anything and
"uncommitted" is a shrinking subset of "branch". The other two wanted both scopes: "what did the
agent do since the last commit" is a real question mid-task. The DX researcher settled the semantics:
the branch scope compares the *working tree* with the merge-base (not `HEAD` with the merge-base),
because the file the agent is editing this second is the one the user most wants to see; the two
scopes are therefore nested.
- A segmented control (Uncommitted · vs main) appears only when a base branch exists and HEAD has
  commits on top of it; otherwise there is one list and the summary reads "vs HEAD". The default is
  the branch scope.
- Base detection (server): the remote's default branch (`refs/remotes/origin/HEAD`), else the first
  of `main`/`master`/`develop`/`trunk` that exists and is not the current branch, else the upstream.
  On `main` itself the base is `origin/main`, so unpushed commits are what the branch scope shows.
  A detached HEAD still compares with the base. No user-configurable base in v1.
- **Decision: two nested scopes, the control only when they differ.**

**Summary and list (visual designer).** One 28px summary line, mono tabular counts: `7 files ·
+120 −38 · 3 commits`, the base right-aligned and faint, a 2px two-colour bar under it. The commit
list was cut (the DX researcher: nobody reviews agent output commit by commit; the count answers "did
it squash?") and lives in the tooltip of the count. Rows are 24px like the tree: badge, basename,
faint directory, fixed-width `+N` `−N` columns so counts align without a table. Names are not tinted
(the counts already carry colour). Renames show `old → new`, deletions strike the name through,
binaries say `bin`, conflicts get a left rule. Surprises sort first: conflicts, deletions, new files,
renames, then edits. A file that was opened dims ("reviewed") until it changes again, so a finished
review is a list of dim rows (the interaction designer's "know when you're done").
- **Decision: adopted.**

**Diff tab vs re-based gutter (disagreement, resolved).** The interaction designer proposed no new
view: re-base the existing gutter markers on the merge-base and keep deletions behind click-to-peek,
to avoid a second renderer. The other two held that reading deletions is the core of reviewing agent
output ("did the tests shrink?") and that a peek-per-hunk does not scale to a 40-file review. The
diff tab won, kept lean: unified only (side-by-side needs ~160 columns; sidebar + terminal on a
laptop leaves ~70), two line-number columns and a `+`/`−` marker, row backgrounds from the existing
git tokens at 12% (20% in the number cells), syntax highlighting untouched, three lines of context
with a clickable "N unchanged lines" row, virtualized like the code view. No word-level diff in v1.
The interaction designer's two fixes were kept: deleted files open (their old side comes from the
merge-base blob), and ⌥F5/⌥⇧F5 walk the hunks of a diff and, at the ends, move on to the
next/previous file, so a review is one key held down. The header shows the file, `+/−`, the base,
`n/N` with ‹ › buttons, and "Open file" (the live file at its first change).
- **Decision: unified diff tab; no side-by-side, ever.**

**Live behaviour (DX researcher).** A stale review list in an agent-watching tool is a bug. The list
refreshes on every git status change while shown (or while diff tabs are open); diff tabs reload when
their file changes on disk and re-diff when the base moves (a commit in the uncommitted scope), keeping
their scroll position. A file the agent reverts keeps its tab and shows "No differences". Diff tabs are
not restored across sessions.
- **Decision: adopted.**

**Engine and security.** One new endpoint, `/api/git/changes?scope=`, built from `git diff --raw
--numstat -z -M <rev> -- .` (raw records give status and rename pairs, numstat the counts; both are
parsed as NUL-separated records, never lines) plus `git ls-files --others --exclude-standard` for
untracked files, whose lines are counted by the server for the first 200 files under 1 MiB, opened
with `O_NOFOLLOW` so an untracked symlink to `~/.ssh` is never read. The list is capped at 1,000
entries. The old side of a diff reuses `/api/git/base` with a `rev` parameter that must be a full
hex object id (any object reachable in the repository is accepted, since a token holder has a shell
anyway; never a ref name, never `-`-prefixed); with a `rev` the path
need not exist on disk (deleted and renamed files) but is checked syntactically. Everything runs
through the hardened runner of §10. Client: paths and subjects are escaped and control characters
made visible (Trojan Source), rows are addressed by index, never by path in an attribute.

**Cut from v1, by the panel:** commits list (count only), user-chosen base, whitespace toggle,
word-level diff, side-by-side, anything that writes (staging, commenting, stash). Those are an SCM
client; this is a viewer.

### As built

- `src/server/git.ts`: `changes()`, `detectBase()`, `base(rel, max, rev)`, `isOid`, `MAX_CHANGES`.
- `src/client/changes.ts`: `ChangesView` (scope control, summary, sorted rows, keyboard, reviewed
  dimming, live refresh) and the pure `letterOf`, `labelOf`, `sortChanges`, `summarize`.
- `src/client/diffview.ts`: `DiffView` (header, virtualized unified rows, gaps, hunk stepping) and the
  pure `buildRows`, `spansHtml`.
- `src/client/editor.ts`: diff tabs (`openDiff`, `refreshDiffs`, `setDiffPositions`); ⌥F5 falls
  through to the next file. `src/client/app.ts`: the Changes side view, ⌘⇧G and ⌥F5 bindings, the
  "Git: Review Changes" and "Git: Compare With Base Branch / HEAD" commands.
- Tests: `servergit.changes`, `http.changes`, `client.changes`, `client.diffview`.

### Adversarial review (security, performance, correctness)

Three independent reviewers attacked the feature with repros and measurements. Every confirmed
finding was fixed and locked in with a test:

| Area | Finding | Fix |
| --- | --- | --- |
| Security (high) | `diff.orderFile=/dev/zero` in a hostile `.git/config` made the new `git diff` grow past 4 GB and never return; `mailmap.file=/dev/zero` did the same to `git log` (and the pre-existing `log -1`/`blame`) | `-O/dev/null` on the diff, `--no-mailmap` on every log, `mailmap.file=/dev/null`, `mailmap.blob=` and `log.mailmap=false` in `HARDEN`; a 30 s kill timer on every git run |
| Security (medium) | `diff.relative=true` made paths cwd-relative, so a subfolder view silently listed nothing; `core.bigFileThreshold=1` turned every count into "bin" | `--no-relative`; `core.bigFileThreshold=512m` in `HARDEN` |
| Security (low) | 200 untracked files × 1 MiB read concurrently into full-size buffers; a rename from outside the viewed folder showed a path above the root | Streamed counting through one 64 KiB buffer, 8 at a time; such renames are shown as added, without the old path |
| Correctness (high) | Merge conflicts never appeared: `git diff <commit>` compares a tree with the working tree and never emits unmerged entries, so the whole conflict path was dead code | `git ls-files --unmerged` overlays `U` entries (test: `UU` and modify/delete) |
| Correctness (high) | Past the 1,000-file cap the parser stopped before the numstat section, so every row lost its counts and never un-dimmed | Skip entries over the cap but keep parsing; `truncated` is set only when something was cut |
| Correctness (medium) | A diff tab kept a stale status when its file left the list: an added file that got committed showed entirely green instead of "No differences"; a restored deleted file stayed "deleted" | A file missing from the list is re-diffed as a plain modification |
| Correctness (low) | `git rm --cached` listed the same path twice (D and ?); submodules were listed as `M +1 −1`; an orphan branch with a staged index showed nothing; EOL-only changes read "No differences" while the list said `+1 −1` | Merged into one `M` entry; mode `160000` skipped; the empty tree is the diff base of an unborn branch; "Only line endings or the final newline changed" |
| Performance (medium) | `/api/git/changes` ran ~10 git processes per call with no coalescing (4 concurrent callers: 650 ms on 100k files) and the client fired a request on every status push | One in-flight run per scope on the server; the client keeps one request in flight and re-runs once afterwards |
| Performance (low) | Every reload of a diff tab refetched the unchanged old blob; ArrowDown rebuilt 1,000 rows | The old side is cached per tab by rev and path; selection moves in place |

Measured and left alone: a 100k-line file with every other line changed builds 200k rows in
2.3 ms and renders a window in 0.6 ms; one change at line 99,990 costs 9.5 ms including lexing
both sides; a diff tab of an 8 MB file holds 11.6 MB.

## 16. Round 7: holistic panel (security, server, client, UX/accessibility)

Four reviewers worked independently from the code and backed each finding with a probe or a
test; the two highest UX findings were raised by two reviewers each. Every finding below was
fixed and, where a harness exists, locked in with a test.

| Area | Finding | Fix |
| --- | --- | --- |
| Security (critical) | `git -c key=value` splits at the *first* `=`, so a hostile repo naming a driver `a=b` kept its filter/textconv armed despite the round-3 blanking | Overrides travel as `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (key and value separate); regression test with an `a=b` driver bound from `.git/info/attributes` |
| Security (low) | Updater fetched any asset URL the API named, with no size limits; a multibyte token header crashed the comparison; PTY upgrade sizes were unbounded | Assets only over https from GitHub's hosts, 1 MB cap on sums/signature and 1 GB on the download; byte-length token compare; upgrade sizes clamped like resizes; CSP from the request origin |
| Security (low) | Markdown external links navigated the locked-down app window itself | Handed to the default browser through `/api/external`, like terminal links |
| Server | Linked worktrees showed the main checkout's merge/rebase; nested repos listed as untracked files; deleted/submodule candidates counted as "binary/large files skipped"; `*.ts` matched only the root; `codeviewer open` failed from a symlinked cwd; a lagging client lost the final output before exit | Per-worktree op markers; editor-style globs; honest skip counts; realpath of the parent; replay before the exit notice |
| Client | DCH/ICH on the second half of a wide character orphaned the WIDE flag (a column vanished); a ZWJ joined the glyph printed after a cursor move; DECSTR kept DEC graphics; C0 bytes landed in OSC titles; closed tabs still built views for loads in flight; terminal views leaked window listeners; a change during an in-flight listing was dropped; tab-indented widths; an empty file at an empty HEAD showed "+1"; an empty list item ended a Markdown list | Fixed, with emulator, tree, code-view and parser tests |
| UX (high) | Linux: Ctrl+Shift+C with no selection sent ^C to the agent; Ctrl+P, Ctrl+=/−/0 never reached the terminal; ⌘W killed a live terminal with no guard; with "Reduce motion" every toast (incl. the OSC 52 notice) and the changed-lines flash were invisible; a lost connection was a 7 px dot | Copy chord is a no-op without a selection; Ctrl shortcuts stay out of a focused terminal on Linux; ⌘W closes exited terminals and asks for a second press otherwise; reduced-motion styles show instead of fade; "disconnected, reconnecting…" in the status bar plus a toast |
| Accessibility | No live region, invisible focus stops (tab close buttons, search results), dialog did not take focus, focus lost after closing a tab, faint text at 2.1–2.9:1 | `aria-live` region fed by every toast; focus-visible styles; dialog focus in/out; next tab focused; secondary text ≥ 3.4:1 and comments ≥ 4.2:1 in both themes; light "bright white" darker than normal text |
| Keyboard | Terminal tabs, the explorer context menu and reattaching a session taken by another window were mouse-only | ⌘⇧[ / ⌘⇧] switch terminals when the terminal is focused; Shift+F10 / Menu key in the explorer; a keystroke reattaches |

A second pass took every remaining item, including the ones first judged not worth the change:

| Area | Finding | Fix |
| --- | --- | --- |
| Security (info) | Every terminal process held the full session token; updater prerelease ordering compared as strings | Terminals get a second token that only `/api/open` honours; semver prerelease identifiers compared per the spec |
| Server | A search superseded by a newer one ended its stream with no summary; `/api/raw` could send a short body after a shrink and could not seek; `detectBase` picked a stale local `master` over `origin/main`; an ignored subfolder viewed as root looked clean; symlinked folders were indexed as files and forced full rebuilds; a shell that exited while no page was attached lost its exit notice | Flagged final `done` line; `Range` support with 206/416 and a failed body on a short read; upstream before local fallbacks on a base branch; `rootIgnored` in the status (the client dims everything); symlinked folders inside the root walked once, outside ones dropped; exited sessions kept for a reattach or 60 s |
| Markdown | Lazy continuation accepted ordered markers and setext underlines inside containers; link reference definitions were single-line only; any open `[` disabled every later autolink | CommonMark rules for all three, with tests |
| Terminal | No screen-reader output; OSC 8 links hid their target | A hidden `role="log"` live region receives each completed line (not in the alternate screen, never during replay); hovering a link shows its target, prefixed with "Link target:" when the label looks like a different host |
| Client | Edits inside a hunk reset opened gaps and the current hunk on live reload; a line requested for a tab still loading was dropped; YAML values such as `url: http://…` were coloured as keys; DCH/ICH probes | Same-shape reloads keep the reader's place; the line is applied when the load lands; a YAML key's colon must be followed by space or end of line |
| UX | Chrome could not be scaled; splitters, terminal tabs, diff gaps and the HEAD peek were mouse-only; same-named tabs were indistinguishable; unreadable folders looked empty; long paths clipped without an ellipsis; shortcut labels mixed macOS glyphs into Linux; ⌘-click and `codeviewer open` were taught once; closing the window could kill a running agent silently | ⌘= / ⌘- also scale the chrome (`zoom` on the chrome containers); focusable splitters with arrow keys and `aria-valuenow`; ⌘⇧[ ] switch terminals from the terminal; gaps open with Enter; "Git: Peek HEAD on Current Line"; a muted folder hint on duplicate names; "Can't read folder: …" and "Loading…" rows; ellipsized status items; platform key labels everywhere; a ⌘/ help sheet with every shortcut and both tips; `beforeunload` asks while a program (title changed) runs in a terminal |
| Accessibility | Lists lacked `aria-activedescendant`; the palette was not a combobox; the find count was silent | Stable row ids and active-descendant wiring on the explorer, Changes list, search results and palette; combobox semantics; the find count is a live region |
