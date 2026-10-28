import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir, cmd);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

/**
 * Codeviewer.app (native WebKit shell) on macOS: the bundle this CLI lives in, or an installed copy.
 */
export function findMacApp(): string | null {
  if (process.platform !== "darwin") return null;
  let exe = process.execPath;
  try {
    exe = realpathSync(exe);
  } catch {}
  const m = /^(.*?\.app)\/Contents\/Resources\/[^/]+$/.exec(exe);
  if (m && existsSync(path.join(m[1]!, "Contents", "MacOS", "Codeviewer"))) return m[1]!;
  for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
    const app = path.join(base, "Codeviewer.app");
    if (existsSync(path.join(app, "Contents", "MacOS", "Codeviewer"))) return app;
  }
  return null;
}

/**
 * The browser engine for the app window, in order of preference:
 * $CODEVIEWER_BROWSER, the ungoogled-chromium bundled next to this executable
 * (Codeviewer.app/Contents/Resources/Chromium.app or <dir>/chromium/chrome),
 * then a Chromium-family browser installed on the system.
 */
export function findAppBrowser(): { path: string; bundled: boolean } | null {
  const env = process.env.CODEVIEWER_BROWSER;
  if (env && existsSync(env)) return { path: env, bundled: false };
  const exeDir = path.dirname(process.execPath);
  const bundled =
    process.platform === "darwin"
      ? path.join(exeDir, "..", "Resources", "Chromium.app", "Contents", "MacOS", "Chromium")
      : path.join(exeDir, "chromium", "chrome");
  if (existsSync(bundled)) return { path: bundled, bundled: true };
  if (process.platform === "darwin") {
    for (const app of ["Chromium", "Google Chrome", "Brave Browser", "Microsoft Edge", "Vivaldi"]) {
      for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
        const bin = path.join(base, `${app}.app`, "Contents", "MacOS", app);
        if (existsSync(bin)) return { path: bin, bundled: false };
      }
    }
  } else {
    for (const b of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave-browser", "microsoft-edge"]) {
      const bin = which(b);
      if (bin) return { path: bin, bundled: false };
    }
  }
  return null;
}

/**
 * Hardened flags for the app window (DESIGN.md §8). The window can only talk to its own
 * loopback server: hostnames resolve to nothing, and any non-loopback connection (including
 * IP literals) is routed to a dead proxy. Loopback always bypasses the proxy.
 */
export function appWindowArgs(url: string, profile: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,920",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-breakpad",
    "--no-pings",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,DialMediaRouteProvider,InterestFeedContentSuggestions",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--proxy-server=127.0.0.1:9",
    "--class=codeviewer",
  ];
}

/**
 * The launch URL carries the session token, and process arguments are visible to every
 * local user (`ps`, /proc/<pid>/cmdline). So browsers are pointed at a bootstrap page in a
 * private 0700 directory (file 0600) that redirects to the real URL; it is deleted shortly after.
 */
export async function bootPage(url: string): Promise<{ fileUrl: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codeviewer-boot-")); // mkdtemp creates 0700
  const file = path.join(dir, "open.html");
  const safe = url.replace(/[^\w:/.#=?&%[\]-]/g, "");
  await writeFile(file, `<!doctype html><meta charset="utf-8"><title>Codeviewer</title><meta http-equiv="refresh" content="0;url=${safe}">`, { mode: 0o600 });
  let done = false;
  const cleanup = async () => {
    if (done) return;
    done = true;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  setTimeout(() => void cleanup(), 60_000).unref();
  return { fileUrl: pathToFileURL(file).href, cleanup };
}

/**
 * Runs the app window and resolves when it closes. Resolves `"failed"` if the browser dies
 * immediately (e.g. a Linux kernel that forbids the sandbox); the sandbox is never disabled.
 */
export async function runAppWindow(browser: string, url: string): Promise<"closed" | "failed"> {
  const profile = await mkdtemp(path.join(os.tmpdir(), "codeviewer-profile-"));
  const boot = await bootPage(url);
  const started = Date.now();
  let stderr = "";
  try {
    const proc = Bun.spawn([browser, ...appWindowArgs(boot.fileUrl, profile)], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    void (async () => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        if (stderr.length < 16_000) stderr += new TextDecoder().decode(r.value);
      }
    })();
    const code = await proc.exited;
    if (Date.now() - started < 3000 && code !== 0) {
      if (/sandbox/i.test(stderr)) {
        console.error(
          "  The bundled browser could not start its sandbox. On Linux, enable unprivileged user\n" +
            "  namespaces or make chromium/chrome-sandbox setuid root (see README).",
        );
      } else if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-5).join("\n"));
      return "failed";
    }
    return "closed";
  } finally {
    await boot.cleanup();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/** Opens our own (token-bearing) URL in the default browser without exposing it in argv. */
export async function openPrivately(url: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      // osascript reads the script from stdin, so the URL never appears in a process list.
      const p = Bun.spawn(["osascript", "-"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      p.stdin.write(`open location "${url.replace(/["\\]/g, "")}"`);
      p.stdin.end();
      return (await p.exited) === 0;
    }
    const boot = await bootPage(url);
    Bun.spawn(["xdg-open", boot.fileUrl], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Opens an external (non-secret) URL in the user's default browser, never in the app window. */
export function openDefault(url: string): boolean {
  const cmd = process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Native folder picker for GUI launches (Finder, desktop entries). Returns null on cancel. */
export async function pickFolder(): Promise<string | null> {
  const run = async (cmd: string[]) => {
    try {
      const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
      const out = (await new Response(p.stdout).text()).trim();
      return (await p.exited) === 0 && out ? out : null;
    } catch {
      return null;
    }
  };
  if (process.platform === "darwin") {
    return run(["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose a folder to open in Codeviewer")']);
  }
  if (which("zenity")) return run(["zenity", "--file-selection", "--directory", "--title=Open folder in Codeviewer"]);
  if (which("kdialog")) return run(["kdialog", "--getexistingdirectory", os.homedir()]);
  return os.homedir();
}
