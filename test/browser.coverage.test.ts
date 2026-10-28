import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appWindowArgs, bootPage, closeAppWindow, findAppBrowser, findMacApp, pickFolder, runAppWindow } from "../src/server/browser.ts";

let tmp = "";
const env = { PATH: process.env.PATH, B: process.env.CODEVIEWER_BROWSER };
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "cv-browser-"));
});
afterEach(async () => {
  process.env.PATH = env.PATH;
  if (env.B === undefined) delete process.env.CODEVIEWER_BROWSER;
  else process.env.CODEVIEWER_BROWSER = env.B;
  await rm(tmp, { recursive: true, force: true });
});

async function script(name: string, body: string) {
  const p = path.join(tmp, name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

test("appWindowArgs isolates the window: own profile, dead proxy, no resolver", () => {
  const a = appWindowArgs("file:///x.html", "/tmp/prof");
  expect(a).toContain("--app=file:///x.html");
  expect(a).toContain("--user-data-dir=/tmp/prof");
  expect(a).toContain("--proxy-server=127.0.0.1:9");
  expect(a.some((x) => x.startsWith("--host-resolver-rules=MAP * ~NOTFOUND"))).toBe(true);
  expect(a).toContain("--disable-extensions");
  expect(a.every((x) => x.startsWith("--"))).toBe(true);
  expect(a).not.toContain("--no-sandbox");
});

test("bootPage writes a private redirect page, strips unsafe chars, and cleans up once", async () => {
  const url = 'http://127.0.0.1:1234/?t=abc"><script>alert(1)</script>#x';
  const b = await bootPage(url);
  const file = fileURLToPath(b.fileUrl);
  expect(existsSync(file)).toBe(true);
  const html = await readFile(file, "utf8");
  expect(html).toContain('http-equiv="refresh"');
  expect(html).not.toContain("<script>");
  expect(html.match(/content="0;url=([^"]*)"/)![1]).toBe("http://127.0.0.1:1234/?t=abcscriptalert1/script#x");
  expect(html).toContain("http://127.0.0.1:1234/?t=abc");
  if (process.platform !== "win32") {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  }
  await b.cleanup();
  expect(existsSync(path.dirname(file))).toBe(false);
  await b.cleanup(); // idempotent
});

test("findAppBrowser prefers $CODEVIEWER_BROWSER when it exists", async () => {
  const fake = await script("mybrowser", "exit 0");
  process.env.CODEVIEWER_BROWSER = fake;
  expect(findAppBrowser()).toEqual({ path: fake, bundled: false });
});

test("findAppBrowser ignores a missing $CODEVIEWER_BROWSER", () => {
  process.env.CODEVIEWER_BROWSER = path.join(tmp, "nope");
  const r = findAppBrowser();
  if (r) expect(r.path).not.toBe(path.join(tmp, "nope"));
});

test.skipIf(process.platform === "darwin")("findAppBrowser finds a Chromium-family browser on PATH (Linux)", async () => {
  delete process.env.CODEVIEWER_BROWSER;
  const exeDir = path.dirname(process.execPath);
  if (existsSync(path.join(exeDir, "chromium", "chrome"))) return; // bundled copy wins
  const fake = await script("chromium", "exit 0");
  process.env.PATH = tmp;
  expect(findAppBrowser()).toEqual({ path: fake, bundled: false });
});

test.skipIf(process.platform === "darwin")("findAppBrowser returns null with nothing installed (Linux)", () => {
  delete process.env.CODEVIEWER_BROWSER;
  if (existsSync(path.join(path.dirname(process.execPath), "chromium", "chrome"))) return;
  process.env.PATH = tmp;
  expect(findAppBrowser()).toBeNull();
});

test("findMacApp is null off macOS and a .app path (or null) on macOS", () => {
  const r = findMacApp();
  if (process.platform !== "darwin") expect(r).toBeNull();
  else if (r) expect(r.endsWith(".app")).toBe(true);
});

test("runAppWindow resolves 'closed' when the browser exits cleanly, and removes its temp profile", async () => {
  const log = path.join(tmp, "args.txt");
  const fake = await script("ok", `printf '%s\\n' "$@" > '${log}'\nexit 0`);
  expect(await runAppWindow(fake, "http://127.0.0.1:9999/?t=secret")).toBe("closed");
  const args = (await readFile(log, "utf8")).split("\n");
  // The token-bearing URL must never reach argv; a boot page is used instead.
  expect(args.join(" ")).not.toContain("secret");
  const app = args.find((a) => a.startsWith("--app="))!;
  expect(app.startsWith("--app=file://")).toBe(true);
  const profile = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
  expect(existsSync(profile)).toBe(false);
  expect(existsSync(fileURLToPath(app.slice("--app=".length)))).toBe(false);
});

test("runAppWindow resolves 'failed' on a quick non-zero exit and explains sandbox errors", async () => {
  const fake = await script("sandboxfail", `echo "No usable sandbox!" >&2\nexit 1`);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    expect(await runAppWindow(fake, "http://127.0.0.1:1/")).toBe("failed");
  } finally {
    console.error = orig;
  }
  expect(errs.join("\n")).toContain("sandbox");
});

test("runAppWindow echoes the browser's stderr tail for other quick failures", async () => {
  const fake = await script("otherfail", `echo "boom" >&2\nexit 2`);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    expect(await runAppWindow(fake, "http://127.0.0.1:1/")).toBe("failed");
  } finally {
    console.error = orig;
  }
  expect(errs.join("\n")).toContain("boom");
});

test("closeAppWindow kills the running window so runAppWindow resolves", async () => {
  const fake = await script("sleeper", "sleep 30");
  const p = runAppWindow(fake, "http://127.0.0.1:1/");
  await Bun.sleep(300);
  closeAppWindow();
  const r = await Promise.race([p, Bun.sleep(8000).then(() => "timeout")]);
  expect(r === "closed" || r === "failed").toBe(true);
  closeAppWindow(); // nothing running: no-op
});

test.skipIf(process.platform === "darwin")("pickFolder uses zenity, then kdialog, then falls back to home (Linux)", async () => {
  process.env.PATH = tmp;
  const home = (await import("node:os")).homedir();
  expect(await pickFolder()).toBe(home);
  await script("kdialog", `echo /picked/kde`);
  expect(await pickFolder()).toBe("/picked/kde");
  await script("zenity", `echo /picked/gtk`);
  expect(await pickFolder()).toBe("/picked/gtk");
  await script("zenity", `exit 1`); // cancel
  expect(await pickFolder()).toBeNull();
});
