// Takes the landing page's screenshots: docs/assets/screenshot-{dark,light}.jpg (the hero) and
// docs/assets/features/<name>-{dark,light}.jpg (one per feature, cropped to what it shows).
//
// macOS only: it builds a demo repository (scripts/demo-repo.ts), serves it with an isolated
// config directory, HOME and shell prompt, and drives an offscreen WKWebView
// (packaging/macos/appshot.swift) through each shot. The JPEGs are committed, so this only needs
// re-running when the UI changes.
//
//   bun run shots              # every shot, both themes
//   bun run shots palette tree # only these
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDemoRepo } from "./demo-repo";

const root = path.resolve(import.meta.dir, "..");
const assets = path.join(root, "docs/assets");
const VERSION = ((await Bun.file(path.join(root, "package.json")).json()) as { version: string }).version;
/** The update dialog shot shows the next minor version as "available". */
const NEXT = VERSION.replace(/^(\d+)\.(\d+)\..*$/, (_, a: string, b: string) => `${a}.${Number(b) + 1}.0`);
const W = 1280;
const H = 800;

type Theme = "dark" | "light";

// ───────────────────────── page helpers (injected before every shot) ─────────────────────────

const HELPERS = `
window.$ = (s) => document.querySelector(s);
window.$$ = (s) => [...document.querySelectorAll(s)];
window.visible = (s) => $$(s).find((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
window.key = (k, o = {}, target) => {
  const code = o.code ?? (k.length === 1 ? (/[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : /[0-9]/.test(k) ? 'Digit' + k : '') : k);
  const ev = new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true, ...o });
  (target ?? document.activeElement ?? document.body).dispatchEvent(ev);
};
window.typeInto = (el, text) => {
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
window.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
window.until = async (f, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = f(); if (v) return v; await sleep(50); }
  throw new Error('timed out waiting for ' + f);
};
window.rect = (els, pad = 0, clamp = true) => {
  const list = (Array.isArray(els) ? els : [els]).map((e) => typeof e === 'string' ? visible(e) : e).filter(Boolean);
  if (!list.length) throw new Error('nothing to crop');
  const rs = list.map((e) => e.getBoundingClientRect());
  let x = Math.min(...rs.map((r) => r.left)) - pad, y = Math.min(...rs.map((r) => r.top)) - pad;
  let x2 = Math.max(...rs.map((r) => r.right)) + pad, y2 = Math.max(...rs.map((r) => r.bottom)) + pad;
  if (clamp) { x = Math.max(0, x); y = Math.max(0, y); x2 = Math.min(innerWidth, x2); y2 = Math.min(innerHeight, y2); }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(x2 - x), h: Math.round(y2 - y) };
};
window.box = (x, y, w, h) => ({ x, y, w, h });
window.mod = (k, o = {}) => key(k, { metaKey: true, ...o }, document.body);
/** The explorer row whose name is \`name\`. */
window.row = (name) => until(() => $$('.tree-rows .row').find((r) => r.textContent.trim() === name || r.querySelector('.name')?.textContent === name));
window.expand = async (...names) => { for (const n of names) { (await row(n)).click(); await sleep(250); } };
/** Runs a palette command by its title. */
window.cmd = async (title) => {
  mod('p', { shiftKey: true });
  const inp = await until(() => visible('.palette-input'));
  typeInto(inp, '>' + title); await sleep(200);
  key('Enter', {}, inp); await sleep(300);
};
/** Clicks the text of line n (1-based) in the visible code view (moves the cursor there). */
window.clickLine = async (n) => {
  const tx = await until(() => visible('.code .ln[data-n="' + (n - 1) + '"] .tx'));
  const r = tx.getBoundingClientRect();
  for (const t of ['mousedown', 'mouseup', 'click']) tx.dispatchEvent(new MouseEvent(t, { bubbles: true, button: 0, clientX: r.left + 40, clientY: r.top + 4 }));
};
/** Line n (1-based; the view's data-n is 0-based). */
window.lineEl = (n) => visible('.code .ln[data-n="' + (n - 1) + '"]');
return 1;
`;

// ───────────────────────────── the shots ─────────────────────────────

import { SHOTS, type Step } from "./shots.list";

// ───────────────────────────── runner ─────────────────────────────

const sh = async (cmd: string[], opts: { quiet?: boolean } = {}) => {
  const p = Bun.spawn(cmd, { stdout: opts.quiet ? "ignore" : "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} failed`);
};

if (process.platform !== "darwin") throw new Error("shots need macOS (WebKit)");
const only = new Set(process.argv.slice(2));
const work = await mkdtemp(path.join(os.tmpdir(), "cv-shots-"));
// The welcome screen shows the folder's absolute path: keep it short and neutral.
const demoParent = "/tmp/codeviewer-demo";
const repo = path.join(demoParent, "harbor");
const home = path.join(work, "home");
const cfg = path.join(work, "cfg");
const tool = path.join(work, "appshot");
let port = 4700 + Math.floor(Math.random() * 200);
let server: ReturnType<typeof Bun.spawn> | null = null;
// Ctrl-C skips `finally`: stop the server and remove the work directory here too.
process.on("SIGINT", async () => {
  server?.kill();
  await rm(work, { recursive: true, force: true });
  await rm(demoParent, { recursive: true, force: true });
  process.exit(130);
});
// The terminal's git must only ever see the demo repository, never a GIT_DIR inherited from a hook.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

try {
  await buildDemoRepo(repo);
  const repoReal = await realpath(repo);
  await mkdir(home, { recursive: true });
  // A neutral prompt: no user name, host or real path in any picture.
  await writeFile(path.join(home, ".zshrc"), `PROMPT='%F{blue}harbor%f %F{magenta}❯%f '\nunsetopt PROMPT_SP\nexport LS_COLORS= CLICOLOR=1\n`);
  await sh(["bun", "scripts/build.ts", "--client-only"], { quiet: true });
  await sh(["xcrun", "swiftc", "-O", path.join(root, "packaging/macos/appshot.swift"), "-o", tool, "-framework", "Cocoa", "-framework", "WebKit"]);
  await mkdir(path.join(assets, "features"), { recursive: true });

  for (const shot of SHOTS) {
    if (only.size && !only.has(shot.name)) continue;
    for (const theme of ["dark", "light"] as Theme[]) {
      await buildDemoRepo(repo); // fresh for every shot: some change files on disk
      await rm(cfg, { recursive: true, force: true });
      await mkdir(path.join(cfg, "codeviewer"), { recursive: true });
      const tabs = shot.tabs ?? [];
      await writeFile(
        path.join(cfg, "codeviewer", "settings.json"),
        JSON.stringify({
          layout: { v: 2, theme, sidebar: true, sidebarWidth: 280, panel: false, panelSize: { bottom: 250, right: 560 }, ...shot.layout },
          [`tabs:${repoReal}`]: { tabs, active: shot.active ?? tabs.at(-1) ?? null },
        }),
      );
      server = Bun.spawn(["bun", "src/server/main.ts", repoReal, "--no-open", "--port", String(++port), "--shell", "/bin/zsh"], {
        cwd: root,
        stdout: "pipe",
        stderr: "inherit",
        env: { ...env, XDG_CONFIG_HOME: cfg, HOME: home, ZDOTDIR: home, CODEVIEWER_NO_UPDATE_CHECK: "1", LANG: "en_US.UTF-8" },
      });
      try {
        const url = await readUrl(server.stdout as ReadableStream<Uint8Array>);
        const steps: Step[] = [{ js: HELPERS, wait: 50 }];
        if (shot.term?.length) steps.push({ js: `await until(() => $$('.term-input').length); return 1;`, wait: 1500 });
        for (const cmd of shot.term ?? []) {
          steps.push({
            js: `const t = await until(() => $$('.term-input').at(-1)); t.focus();
                 const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(cmd)});
                 t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                 key('Enter', {}, t); return 1;`,
            wait: 900,
          });
        }
        steps.push(...shot.steps);
        steps.push({ js: shot.crop ?? "return null;", wait: 0 });
        const stepsFile = path.join(work, `${shot.name}.json`);
        await writeFile(stepsFile, JSON.stringify(steps).replaceAll("__VERSION__", VERSION).replaceAll("__NEXT__", NEXT));
        const png = path.join(work, `${shot.name}-${theme}.png`);
        await sh([tool, url, stepsFile, png, String(W), String(H), theme]);
        const stem = shot.out ?? `features/${shot.name}`;
        const jpg = path.join(assets, `${stem}-${theme}.jpg`);
        // Feature crops show at most ~800 CSS px wide on the page: 1600 px keeps them sharp on Retina.
        const fit = !shot.out && (await pngSize(png)).some((n) => n > 1600) ? ["-Z", "1600"] : [];
        await sh(["sips", ...fit, "-s", "format", "jpeg", "-s", "formatOptions", "80", png, "--out", jpg], { quiet: true });
        // A half-size variant for phones and 1x screens (srcset in scripts/site.ts).
        const longest = Math.min(Math.max(...(await pngSize(png))), fit.length ? 1600 : Infinity);
        await sh(["sips", "-Z", String(Math.round(longest / 2)), "-s", "format", "jpeg", "-s", "formatOptions", "78", png, "--out", jpg.replace(/\.jpg$/, "-half.jpg")], { quiet: true });
        console.log(`shot     docs/assets/${stem}-${theme}.jpg (and -half)`);
      } finally {
        server.kill();
        await server.exited;
        server = null;
      }
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
  await rm(demoParent, { recursive: true, force: true });
}

/** Width and height of a PNG, from its IHDR chunk. */
async function pngSize(file: string): Promise<[number, number]> {
  const v = new DataView((await Bun.file(file).slice(16, 24).arrayBuffer()) as ArrayBuffer);
  return [v.getUint32(0), v.getUint32(4)];
}

async function readUrl(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const m = text.replace(/\x1b\[[0-9;]*m/g, "").match(/http:\/\/\S+#t=\S+/);
    if (m) {
      reader.releaseLock();
      return m[0];
    }
  }
  throw new Error(`server did not print its URL:\n${text}`);
}
