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

  /** Replaces every setting. */
  write(data: unknown): Promise<void> {
    let text: string;
    try {
      text = serialize(data);
    } catch (e) {
      return Promise.reject(e);
    }
    return this.enqueue(() => this.persist(text));
  }

  /**
   * Sets the given keys and keeps every other one as it is on disk. Each window sends only what it
   * changed: whole snapshots from two windows (or two folders) overwrote each other's keys.
   * A key that is set moves to the end, so the per-folder `tabs:` entries are in recency order and
   * only the newest MAX_TAB_ROOTS are kept.
   */
  patch(changes: unknown): Promise<void> {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) return Promise.reject(new Error("object expected"));
    if (depth(changes) > MAX_DEPTH) return Promise.reject(new Error("settings nested too deeply"));
    return this.enqueue(async () => {
      // Merged in a Map: the keys come from the request, and a plain object would take
      // `__proto__`, `constructor` and friends as property writes on itself.
      const cur = new Map(Object.entries(await this.read()));
      for (const [k, v] of Object.entries(changes)) {
        cur.delete(k);
        if (v !== null) cur.set(k, v); // null removes the key
      }
      const roots = [...cur.keys()].filter((k) => k.startsWith("tabs:"));
      for (const k of roots.slice(0, Math.max(0, roots.length - MAX_TAB_ROOTS))) cur.delete(k);
      await this.persist(serialize(Object.fromEntries(cur)));
    });
  }

  /** Serialized and atomic (temp file + rename): a crash never leaves a torn file, and a failed write does not poison later ones. */
  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queue = this.queue.catch(() => {}).then(job);
    return this.queue;
  }

  private async persist(text: string) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

/**
 * Indented JSON of a settings object. Indented output grows with the square of the nesting depth
 * (40 KB of `[` became an 800 MB file): settings are shallow, so deep values are refused and the
 * written size is capped.
 */
function serialize(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("object expected");
  if (depth(data) > MAX_DEPTH) throw new Error("settings nested too deeply");
  const text = JSON.stringify(data, null, 2);
  if (text.length > MAX_BYTES) throw new Error("settings too large");
  return text;
}

/** Folders whose open tabs are remembered (`tabs:<root>` keys), most recently saved first. */
const MAX_TAB_ROOTS = 100;
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
