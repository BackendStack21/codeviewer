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
  default browser via `osascript` reading from stdin.
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
│   watch.ts    recursive fs.watch → debounced change events                    │
│   pty.ts      Bun.spawn({terminal}) sessions ↔ WebSocket                     │
├────────────────────────────────── client/ (vanilla TS, bundled) ──────────────┤
│   app.ts        layout, splitters, keyboard, state                            │
│   tree.ts       lazy virtualized file tree                                    │
│   editor.ts     tabs; dispatches to code / image / binary views               │
│   codeview.ts   virtualized lines, gutter, find, go-to-line, change flash     │
│   highlight.ts  incremental multi-language tokenizer                          │
│   palette.ts    fuzzy quick-open                                              │
│   term/         terminal.ts (parser+screen), renderer.ts (canvas),            │
│                 input.ts (keys/mouse), width.ts, boxdraw.ts                   │
└───────────────────────────────────────────────────────────────────────────────┘
REST:  GET /api/info · /api/list?path · /api/file?path · /api/raw?path · /api/index
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
