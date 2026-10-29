# Security policy

Codeviewer serves a real shell to a local window, so security issues are taken seriously.
The threat model and the hardening are documented in [DESIGN.md](DESIGN.md) (§5, §8–§11).

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's
[private vulnerability reporting](https://github.com/BackendStack21/codeviewer/security/advisories/new).
Include the version, OS, and the steps to reproduce. Expect an acknowledgement within a few days.

## Markdown preview

The content of every viewed file, Markdown included, is untrusted. The Markdown renderer builds its DOM
with `createElement` and `textContent` only (never `innerHTML`), shows raw HTML as text, allows only
`http`, `https`, `mailto`, `#fragment` and relative link targets, prefixes heading ids with `md-`, and loads
no remote images: relative images are fetched through the authenticated raw endpoint as blob URLs (revoked on
re-render and close, image extensions only, at most 100 per render) and the Content-Security-Policy is not
widened. Report any way around these as a vulnerability.

## Verifying a download

Every release is built by GitHub Actions from a tagged commit and ships with `SHA256SUMS`, an
Ed25519 signature of it (`SHA256SUMS.sig`, key in `packaging/update-key.pub`; the in-app
updater refuses anything that doesn't verify) and signed build-provenance attestations.
See https://codeviewer.21no.de/#verify.
