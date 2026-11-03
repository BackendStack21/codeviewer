import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Per-user config directory (XDG on Linux, Application Support on macOS). */
export function configDir(): string {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "codeviewer");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "codeviewer");
  return path.join(os.homedir(), ".config", "codeviewer");
}

/**
 * UI settings live on the server, not in browser storage: the app window uses a throwaway
 * profile and a random port, so localStorage would not survive a relaunch.
 */
export class Settings {
  private file = path.join(configDir(), "settings.json");
  private queue: Promise<void> = Promise.resolve();

  async read(): Promise<Record<string, unknown>> {
    try {
      const v = JSON.parse(await readFile(this.file, "utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  write(data: unknown): Promise<void> {
    if (!data || typeof data !== "object" || Array.isArray(data)) return Promise.reject(new Error("object expected"));
    // Indented output grows with the square of the nesting depth (40 KB of `[` became an 800 MB
    // file): settings are shallow, so deep values are refused and the written size is capped.
    if (depth(data) > MAX_DEPTH) return Promise.reject(new Error("settings nested too deeply"));
    const text = JSON.stringify(data, null, 2);
    if (text.length > MAX_BYTES) return Promise.reject(new Error("settings too large"));
    // Serialize writes and replace atomically so a crash never leaves a torn file.
    // A failed write must not poison every later one.
    this.queue = this.queue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.queue;
  }
}

const MAX_DEPTH = 32;
const MAX_BYTES = 1024 * 1024;

/** Nesting depth of a JSON value, stopping as soon as it passes MAX_DEPTH (no deep recursion). */
function depth(v: unknown): number {
  let level: unknown[] = [v];
  let d = 0;
  while (level.length) {
    d++;
    if (d > MAX_DEPTH) return d;
    const next: unknown[] = [];
    for (const x of level) if (x && typeof x === "object") for (const y of Object.values(x as object)) next.push(y);
    level = next;
  }
  return d - 1;
}
