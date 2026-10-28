import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Directories that are never worth walking for quick-open. */
export const HEAVY_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", ".next", ".nuxt", ".turbo",
  ".cache", ".parcel-cache", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
  ".pytest_cache", ".gradle", ".terraform", ".DS_Store", "target", ".zig-cache", "zig-out",
]);

const MAX_FILES = 200_000;

/**
 * Background list of every file under the root, used by quick-open.
 * Rebuilt lazily after the watcher reports a structural change.
 */
export class FileIndex {
  private files: Set<string> | null = null;
  private building: Promise<Set<string>> | null = null;
  private text: string | null = null;

  constructor(private root: string) {}

  private dirs: Set<string> | null = null;

  /** Forces a full rebuild on the next request. */
  invalidate() {
    this.files = null;
    this.building = null;
    this.text = null;
    this.dirs = null;
  }

  /** Directories that contain indexed files (derived lazily from the file set). */
  private knownDirs(): Set<string> {
    if (!this.dirs) {
      this.dirs = new Set();
      for (const f of this.files ?? []) {
        for (let i = f.lastIndexOf("/"); i > 0; i = f.lastIndexOf("/", i - 1)) {
          const d = f.slice(0, i);
          if (this.dirs.has(d)) break;
          this.dirs.add(d);
        }
      }
    }
    return this.dirs;
  }

  async get(): Promise<string> {
    if (!this.files) {
      this.building ??= this.build().then((set) => (this.files = set));
      await this.building;
    }
    return (this.text ??= [...this.files!].join("\n"));
  }

  /**
   * Applies watcher paths incrementally. Returns true when the set of files changed
   * (created/deleted/renamed); plain content edits return false.
   */
  async apply(paths: string[]): Promise<boolean> {
    const files = this.files;
    if (!files) return true;
    if (paths.length > 2000) {
      this.invalidate();
      return true;
    }
    let changed = false;
    await Promise.all(
      paths.map(async (p) => {
        if (p.split("/").some((seg) => HEAVY_DIRS.has(seg))) return;
        const st = await stat(path.join(this.root, p)).catch(() => null);
        if (st?.isDirectory()) {
          // Events for known directories are just content churn inside them. A new (or
          // moved-in) directory may hold many files: rescan from scratch.
          if (!this.knownDirs().has(p)) {
            this.invalidate();
            changed = true;
          }
        } else if (st && !files.has(p)) {
          files.add(p);
          this.dirs = null;
          changed = true;
        } else if (!st) {
          if (files.delete(p)) changed = true;
          // A deleted directory: drop everything under it.
          for (const f of files) if (f.startsWith(p + "/")) {
            files.delete(f);
            changed = true;
          }
        }
      }),
    );
    if (changed) this.text = null;
    return changed;
  }

  private async build(): Promise<Set<string>> {
    const out: string[] = [];
    // Breadth-first so shallow files win when the cap is hit.
    let level: string[] = [""];
    while (level.length && out.length < MAX_FILES) {
      const next: string[] = [];
      await Promise.all(
        level.map(async (rel) => {
          let dirents;
          try {
            dirents = await readdir(path.join(this.root, rel), { withFileTypes: true });
          } catch {
            return;
          }
          for (const d of dirents) {
            const p = rel ? rel + "/" + d.name : d.name;
            if (d.isDirectory()) {
              if (!HEAVY_DIRS.has(d.name)) next.push(p);
            } else if (out.length < MAX_FILES) {
              out.push(p);
            }
          }
        }),
      );
      level = next;
    }
    return new Set(out);
  }
}
