import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// The rules in AGENTS.md ("Rules that are easy to break"), checked against the source so that a
// future change breaking one fails here with the rule's name, not in a review months later.

const ROOT = path.join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
function files(dir: string, ext = /\.ts$/): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...files(rel, ext));
    else if (ext.test(name)) out.push(rel);
  }
  return out;
}
/** Source without comments, so a rule is checked against code, not prose about it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const SERVER = files("src/server");
const CLIENT = files("src/client");

describe("No dependencies", () => {
  test("package.json declares no packages of any kind", () => {
    const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;
    for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"]) {
      expect(pkg[k]).toBeUndefined();
    }
  });

  test("no import names a package (only relative paths, node: and bun builtins)", () => {
    for (const f of [...SERVER, ...CLIENT, ...files("scripts")]) {
      for (const m of read(f).matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)) {
        const spec = m[1]!;
        const ok = spec.startsWith(".") || spec.startsWith("node:") || spec === "bun" || spec.startsWith("bun:");
        if (!ok) throw new Error(`${f} imports "${spec}"`);
      }
    }
  });

  test("the page loads nothing from another origin", () => {
    const html = read("src/client/index.html");
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
  });
});

describe("Privacy: the only outbound request is the update check", () => {
  test("server code opens no sockets of its own", () => {
    for (const f of SERVER) {
      const c = code(f);
      for (const api of [/\bnet\.connect\(/, /\bBun\.connect\(/, /\bhttps?\.request\(/, /\bnew WebSocket\(/, /\bdgram\b/, /\bBun\.udpSocket\(/]) {
        if (api.test(c)) throw new Error(`${f} uses ${api}`);
      }
    }
  });

  test("fetch() is called only by the updater and by `codeviewer open` (loopback)", () => {
    const callers = SERVER.filter((f) => /\bfetch\(/.test(code(f).replace(/async fetch\(req/g, "")));
    expect(callers.sort()).toEqual(["src/server/main.ts", "src/server/update.ts"]);
    // `codeviewer open` talks only to the URL its own terminal was given.
    expect(code("src/server/main.ts")).toMatch(/fetch\(`\$\{url\}\/api\/open`/);
  });

  test("the updater only talks to GitHub", () => {
    const u = read("src/server/update.ts");
    expect(u).toMatch(/https:\/\/api\.github\.com\/repos\/\$\{REPO\}\/releases\/latest/);
    const hosts = /export const ASSET_HOSTS = \[([^\]]*)\]/.exec(u)![1]!;
    for (const h of hosts.match(/"[^"]+"/g)!) expect(h).toMatch(/^"([a-z-]+\.)*(github\.com|githubusercontent\.com)"$/);
  });

  test("client requests are same-origin (relative URLs only)", () => {
    for (const f of CLIENT) {
      for (const m of code(f).matchAll(/\bfetch\(\s*(["'`])([^"'`]*)/g)) {
        if (!m[2]!.startsWith("/") && !m[2]!.startsWith("${")) throw new Error(`${f}: fetch(${m[1]}${m[2]}`);
      }
      if (/new WebSocket\((?!wsUrl\()/.test(code(f))) throw new Error(`${f} opens a WebSocket without wsUrl()`);
    }
  });
});

describe("Git hardening", () => {
  test("git is spawned only by git.ts, and every run carries HARDEN", () => {
    for (const f of SERVER.filter((f) => f !== "src/server/git.ts")) {
      expect(code(f)).not.toMatch(/\[\s*["']git["']|which\(["']git["']\)/);
    }
    const g = code("src/server/git.ts");
    const runs = [...g.matchAll(/\brun\((?:this\.)?bin,[^\n]*/g)].map((m) => m[0]);
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r).toContain("...HARDEN");
  });

  test("HARDEN holds only literal `-c` pairs (overrides from data go through GIT_CONFIG_KEY_n)", () => {
    const g = read("src/server/git.ts");
    const block = /const HARDEN = \[([\s\S]*?)\n\];/.exec(g)![1]!.replace(/\/\/.*$/gm, "");
    const items = block.match(/"[^"]*"|`[^`]*`|[A-Za-z_$][\w$.]*/g)!;
    for (let i = 0; i < items.length; i += 2) {
      expect(items[i]).toBe('"-c"');
      expect(items[i + 1]).toMatch(/^"[a-zA-Z0-9.]+=[^"]*"$/); // a literal key=value, no interpolation
    }
  });

  test("the run environment forbids transports and lazy fetches, and never prompts or pages", () => {
    const g = read("src/server/git.ts");
    const env = /const ENV = \{([\s\S]*?)\n\};/.exec(g)![1]!;
    for (const kv of ['GIT_ALLOW_PROTOCOL: ""', 'GIT_NO_LAZY_FETCH: "1"', 'GIT_OPTIONAL_LOCKS: "0"', 'GIT_TERMINAL_PROMPT: "0"', 'GIT_PAGER: "cat"']) {
      expect(env).toContain(kv);
    }
    const harden = /const HARDEN = \[([\s\S]*?)\n\];/.exec(g)![1]!;
    for (const k of [
      "core.fsmonitor=false", "diff.external=", "diff.ignoreSubmodules=all", "core.attributesFile=/dev/null", "log.showSignature=false",
      "diff.autoRefreshIndex=false", "core.hooksPath=/dev/null",
    ]) {
      expect(harden).toContain(`"${k}"`);
    }
  });
});

describe("Auth", () => {
  test("tokens are compared only with tokenOk (constant time)", () => {
    const h = code("src/server/http.ts");
    expect(h).not.toMatch(/[=!]==?\s*(opts\.token|openToken)\b|\b(opts\.token|openToken)\s*[=!]==?/);
    expect(h).toMatch(/timingSafeEqual/);
  });

  test("the server never logs (no request data, path or token can reach a log)", () => {
    for (const f of ["src/server/http.ts", "src/server/files.ts", "src/server/search.ts", "src/server/search.worker.ts", "src/server/git.ts", "src/server/pty.ts", "src/server/index.ts", "src/server/watch.ts", "src/server/settings.ts"]) {
      expect(code(f)).not.toMatch(/\bconsole\.(log|error|warn|info|debug)\(/);
    }
  });

  test("Bun's development error page stays off", () => {
    const h = code("src/server/http.ts");
    expect(h).toMatch(/development:\s*false/);
    expect(h).toMatch(/\berror\(\)\s*\{\s*return fail\(500/);
  });
});

describe("Read-only and containment", () => {
  test("the HTTP layer reads files only through files.ts (resolveSafe + openRegular)", () => {
    const h = code("src/server/http.ts");
    expect(h).not.toMatch(/\breadFile\(|\bcreateReadStream\(|\bopenSync\(|from "node:fs"/);
    const bunFiles = [...h.matchAll(/Bun\.file\(([^)]*)\)/g)].map((m) => m[1]);
    expect(bunFiles).toEqual(["FONTS[p]!"]); // the embedded fonts, never a request path
  });

  test("openRegular keeps O_NOFOLLOW and O_NONBLOCK, and the search worker opens with both too", () => {
    expect(code("src/server/files.ts")).toMatch(/O_RDONLY \| constants\.O_NOFOLLOW \| constants\.O_NONBLOCK/);
    expect(code("src/server/search.worker.ts")).toMatch(/O_RDONLY \| constants\.O_NOFOLLOW \| constants\.O_NONBLOCK/);
  });

  test("no server code writes outside the settings file and the updater's staging dir", () => {
    const writers = /\b(writeFile|appendFile|rename|rm|unlink|mkdir|chmod|copyFile|symlink|truncate)(Sync)?\(|Bun\.write\(|\.writer\(\)/;
    const allowed = new Set(["src/server/settings.ts", "src/server/update.ts", "src/server/browser.ts"]);
    for (const f of SERVER) if (!allowed.has(f) && writers.test(code(f))) throw new Error(`${f} writes to the file system`);
  });
});

describe("Untrusted content", () => {
  test("Markdown is rendered without innerHTML", () => {
    for (const f of ["src/client/markdown.ts", "src/client/mdrender.ts", "src/client/mdimage.ts"]) {
      expect(code(f)).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|document\.write\(/);
    }
  });

  test("the app shell CSP is exactly as strict as reviewed (it must not widen)", () => {
    const h = read("src/server/http.ts");
    const csp = /`default-src 'self'; script-src 'self';[^`]*`\s*\+\s*\n?\s*`[^`]*`/.exec(h)![0].replace(/`\s*\+\s*`/, "");
    expect(csp).toBe(
      "`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; " +
        "connect-src 'self' ws://${new URL(req.url).host}; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`",
    );
    // Raw files: no script even when an SVG or HTML file is opened directly.
    expect(h).toContain(`"default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"`);
  });

  test("innerHTML in the client is only ever built from escaped values or fixed markup", () => {
    // Each `innerHTML = …${x}…` interpolation must be esc()/safe()/a known-safe helper or a number.
    const SAFE = /^(esc|safe|safeText|markBidi|showHidden|icons\.|fileIcon|folderIcon|highlight|plural|spansHtml|labelOf|this\.lineHtml|renderRow|row\(|chevron|[a-z]+Html|String\(|Number\(|\d|i\b|n\b|count|cls|idx|ms\b)/;
    const bad: string[] = [];
    for (const f of CLIENT) {
      for (const m of code(f).matchAll(/\.innerHTML\s*=\s*(`[^`]*`)/g)) {
        for (const e of m[1]!.matchAll(/\$\{\s*([^}]*)\}/g)) {
          const expr = e[1]!.trim();
          const numeric = /(\.length|\.toLocaleString\(\))$|^Math\./.test(expr);
          if (!SAFE.test(expr) && !numeric && !/^[^`]*\?\s*["'`][^"'`<]*["'`]\s*:\s*["'`]/.test(expr)) bad.push(`${f}: \${${expr}}`);
        }
      }
    }
    // Reviewed exceptions: numbers from the server, and a message assembled from safe() pieces.
    // A new entry here needs the same review: is every byte of it escaped or a number?
    const REVIEWED = new Set([
      "src/client/app.ts: ${g.stash}", // Number(...) on the server
      "src/client/app.ts: ${s.diff.added}", // counts
      "src/client/app.ts: ${s.diff.removed}",
      "src/client/changes.ts: ${msg}", // built from safe(this.vs) / safe(d.base.name)
    ]);
    expect(bad.filter((b) => !REVIEWED.has(b))).toEqual([]);
  });
});

describe("Process boundaries", () => {
  test("the compiled binary never autoloads bunfig.toml or .env from its working directory (the viewed folder)", () => {
    const b = code("scripts/build.ts");
    const compile = /async function compile\([\s\S]*?\n\}/.exec(b)![0];
    for (const f of ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv"]) expect(compile).toContain(`"${f}"`);
    // And the Mac app starts the server outside the viewed folder.
    expect(code("packaging/macos/main.swift")).toMatch(/process\.currentDirectoryURL = URL\(fileURLWithPath: "\/"\)/);
  });

  test("the app window writes nothing to disk and cannot reach the network", async () => {
    const { appWindowArgs } = await import("../src/server/browser.ts");
    const a = appWindowArgs("file:///x.html", "/tmp/p");
    for (const f of ["--incognito", "--proxy-server=127.0.0.1:9", "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-extensions"]) expect(a).toContain(f);
    expect(a.some((x) => x.startsWith("--host-resolver-rules=MAP * ~NOTFOUND"))).toBe(true);
  });

  test("`codeviewer open` sends the open-only token only to a codeviewer on this machine", async () => {
    const src = code("src/server/main.ts");
    expect(src).toMatch(/redirect: "error"/);
    expect(src).toMatch(/if \(!isLocalViewerUrl\(url\)\)/);
  });
});

describe("Source hygiene", () => {
  test("no source or test file holds raw bidi controls (write them as \\u escapes)", () => {
    const raw = /[\u202a-\u202e\u2066-\u2069]/;
    for (const f of [...SERVER, ...CLIENT, ...files("test"), ...files("scripts")]) if (raw.test(read(f))) throw new Error(`${f} contains a raw bidi control`);
  });
});

