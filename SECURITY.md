# Security policy

Codeviewer serves a real shell to a local window, so security issues are taken seriously.
The threat model and the hardening are documented in [DESIGN.md](DESIGN.md) (§5, §8–§11).

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's
[private vulnerability reporting](https://github.com/BackendStack21/codeviewer/security/advisories/new).
Include the version, OS, and the steps to reproduce. Expect an acknowledgement within a few days.

## Privacy

Codeviewer collects nothing. It is a local server bound to `127.0.0.1` and a window locked to that
server; file contents, terminal output and usage never leave the machine. The only outbound request is
the launch-time check of GitHub's releases API for a newer version, which "Toggle Automatic Update
Checks" or `CODEVIEWER_NO_UPDATE_CHECK=1` disables entirely. Any other network access by Codeviewer
itself would be a bug: please report it as a vulnerability.

## Terminals and tokens

The session token travels only in the URL fragment and a request header, never in a cookie or a
process environment. Shells started by Codeviewer receive a separate, narrower token that the server
honours for one purpose: `codeviewer open <file:line>` asking the viewer to show a file. It cannot read
files, search or attach to terminals, and `codeviewer open` sends it only to a codeviewer on this
machine (loopback or an own interface, no redirects).

The app window keeps nothing on disk (`--incognito`): a normal browser profile recorded the launch
URL, so a process in a terminal could have read the session token there and typed into the other
terminals. Its boot page is deleted as soon as the page connects, and the token URL is printed only
to a terminal. With `--browser` the token lives in your own browser's session storage and history for
as long as the server runs; it is useless once the server stops.

The compiled server never loads `bunfig.toml` or `.env` from its working directory, which is often the
folder being viewed (a repository's `bunfig.toml` could otherwise preload its own code into the
server). Running from source (`bun src/server/main.ts`) does load them: start it from outside the
folder you view.

## Git

Every git call runs with filters, textconv, diff drivers, fsmonitor, signature checks, mailmap,
hooks (`core.hooksPath=/dev/null`) and submodules off, with driver overrides passed as
`GIT_CONFIG_KEY_n`/`VALUE_n`, and never writes the index (`diff.autoRefreshIndex=false`: a diff
otherwise refreshes it, and writing the index runs the repository's `post-index-change` hook).
Files git reads whole (`config`, `HEAD`, `commondir`, `info/*`, `objects/info/alternates`, …) must
be regular files of a sane size, or git is not used for that folder; `GIT_DIR`-style variables from
the environment are dropped. No git call may use a transport (`GIT_ALLOW_PROTOCOL` empty, `GIT_NO_LAZY_FETCH`):
a partial clone would otherwise fetch missing objects from its promisor remote, running the
programs the repository's config names for it (`remote.*.uploadpack`, `core.sshCommand`). File History runs `git --literal-pathspecs log --follow` for one file that must
exist inside the served root, at most 500 commits and 4 MB of output; each side of a commit's diff is
read with `cat-file` by full object id, never from a revision expression the client chose.

Commands that type into a terminal ("Insert Reference in Terminal") send one line as a paste and
never press Enter, and refuse file names with control characters or command substitution.
After a reload the server restores the terminal's input modes (bracketed paste, mouse) with a parser
that mirrors the page's, so output cannot make the two disagree.

## Updates

The in-app updater downloads only from GitHub over https, caps the sizes it will read, requires a
valid Ed25519 signature on `SHA256SUMS` from `packaging/update-key.pub`, verifies the file's SHA-256
and swaps the installation atomically. The checksum is taken from the file as written, so a short
write (a full disk) fails it. Prerelease versions (a `-` in the tag) are never offered.

## Markdown preview

The content of every viewed file, Markdown included, is untrusted. The Markdown renderer builds its DOM
with `createElement` and `textContent` only (never `innerHTML`), shows raw HTML as text, allows only
`http`, `https`, `mailto`, `#fragment` and relative link targets, prefixes heading ids with `md-`, and loads
no remote images: relative images are fetched through the authenticated raw endpoint as blob URLs (revoked on
re-render and close, image extensions only, at most 100 per render) and the Content-Security-Policy is not
widened. In the Mac app those blob URLs are the only addition to the window's network rules: it blocks every
URL except `http://` and `ws://` on its own `127.0.0.1` port and `blob:` URLs minted by that same origin. Report
any way around these as a vulnerability.

## Verifying a download

Every release is built by GitHub Actions from a tagged commit and ships with `SHA256SUMS`, an
Ed25519 signature of it (`SHA256SUMS.sig`, key in `packaging/update-key.pub`; the in-app
updater refuses anything that doesn't verify) and signed build-provenance attestations.
See https://codeviewer.21no.de/#verify.
