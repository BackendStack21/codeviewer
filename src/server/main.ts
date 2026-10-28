#!/usr/bin/env bun
import { realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { startServer, VERSION } from "./http.ts";
import { findAppBrowser, findMacApp, openDefault, openPrivately, pickFolder, runAppWindow } from "./browser.ts";

const HELP = `codeviewer ${VERSION}: a fast, read-only code viewer with a built-in terminal

Usage:
  codeviewer [dir] [options]       View a directory (default: current directory)
  codeviewer open <file[:line]>    Open a file in the running viewer (from its terminal)

Options:
  -p, --port <n>      Port to listen on (default: random free port)
      --host <addr>   Interface to bind (default: 127.0.0.1). Exposes a shell: be careful!
      --shell <path>  Shell for terminals (default: $SHELL)
      --no-open       Don't open a window; just print the URL (headless / SSH)
      --browser       Open in your default browser instead of the app window
  -v, --version       Print version
  -h, --help          Show this help
`;

function die(msg: string): never {
  console.error(`codeviewer: ${msg}`);
  process.exit(1);
}

async function openCommand(target: string | undefined) {
  if (!target) die("usage: codeviewer open <file[:line]>");
  const url = process.env.CODEVIEWER_URL;
  const token = process.env.CODEVIEWER_TOKEN;
  if (!url || !token) die("not inside a codeviewer terminal (CODEVIEWER_URL is not set)");
  const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(target)!;
  const file = path.resolve(m[1]!);
  const res = await fetch(`${url}/api/open`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cv-token": token },
    body: JSON.stringify({ path: file, line: Number(m[2] ?? 0) }),
  }).catch((e: Error) => die(`cannot reach viewer: ${e.message}`));
  if (!res.ok) die(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "open") return openCommand(args[1]);

  let dir: string | null = null;
  let port = 0;
  let host = "127.0.0.1";
  let shell = process.env.SHELL || (existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");
  let open = true;
  let appWindow = true;
  let machine = false;
  let exitWithParent = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = () => args[++i] ?? die(`${a} needs a value`);
    if (a === "-h" || a === "--help") return void console.log(HELP);
    else if (a === "-v" || a === "--version") return void console.log(VERSION);
    else if (a === "-p" || a === "--port") port = Number(next());
    else if (a === "--host") host = next();
    else if (a === "--shell") shell = next();
    else if (a === "--no-open") open = false;
    else if (a === "--browser") appWindow = false;
    else if (a === "--machine") machine = true; // used by Codeviewer.app: print {"url"} JSON only
    else if (a === "--exit-with-parent") exitWithParent = true;
    else if (a.startsWith("-")) die(`unknown option ${a}\n\n${HELP}`);
    else dir = a;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) die("invalid port");

  // Launched from Finder / a desktop entry (no terminal, no folder): ask for one.
  if (dir === null) {
    if (process.stdin.isTTY || !open) dir = ".";
    else {
      dir = await pickFolder();
      if (!dir) process.exit(0);
    }
  }

  let root: string;
  try {
    root = await realpath(path.resolve(dir));
    if (!(await stat(root)).isDirectory()) die(`${dir} is not a directory`);
  } catch {
    die(`cannot open ${dir}`);
  }

  // macOS: hand the folder to Codeviewer.app (native window), like `code .` does.
  const macApp = open && appWindow && !machine ? findMacApp() : null;
  if (macApp) {
    const p = Bun.spawn(["open", "-n", "-a", macApp, "--args", "--folder", root], { stdio: ["ignore", "inherit", "inherit"] });
    if ((await p.exited) === 0) return void console.log(`Opened ${root} in Codeviewer.`);
  }

  const token = randomBytes(32).toString("base64url");
  const app = startServer({ root, port, host, shell, token, openExternal: (u) => void openDefault(u) });

  const quit = () => {
    app.stop();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);
  // If the owning app dies without cleaning up, don't leave an orphan server (and shells) behind.
  if (exitWithParent) {
    const parent = process.ppid;
    setInterval(() => {
      if (process.ppid !== parent) quit();
    }, 1000).unref();
  }

  if (machine) return void console.log(JSON.stringify({ url: app.url, root }));

  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  console.log(`\n  \x1b[1;38;2;125;170;255m◆ codeviewer\x1b[0m ${dim(VERSION)}\n`);
  console.log(`  ${dim("root")}  ${root}`);
  console.log(`  ${dim("url ")}  ${app.url}\n`);
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.log(`  \x1b[33m⚠ Listening on ${host}: anyone with the URL gets a shell on this machine.\x1b[0m\n`);
  }

  if (!open) return void console.log(dim("  Press Ctrl+C to quit.\n"));

  const browser = appWindow ? findAppBrowser() : null;
  if (browser) {
    console.log(dim(`  app window: ${browser.bundled ? "bundled ungoogled-chromium" : browser.path}`));
    console.log(dim("  Close the window or press Ctrl+C to quit.\n"));
    if ((await runAppWindow(browser.path, app.url)) === "closed") {
      // Give the page's final settings write a moment to land.
      await Bun.sleep(150);
      quit();
    }
    console.error(`  Falling back to your default browser.\n`);
  }
  console.log(dim("  Press Ctrl+C to quit.\n"));
  if (!(await openPrivately(app.url))) console.log("  Open the URL above in your browser.");
}

await main();
