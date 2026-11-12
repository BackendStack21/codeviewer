import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Directories that are never worth walking for quick-open. */
export const HEAVY_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", ".next", ".nuxt", ".turbo",
  ".cache", ".parcel-cache", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
  ".pytest_cache", ".gradle", ".terraform", ".DS_Store", "target", ".zig-cache", "zig-out",
]);

/**
 * A file left out of listings: anything under a heavy folder, and .DS_Store itself. A plain file
 * that only shares a folder's name (`target`, `venv`) is listed. "dir/" is a folder.
 */
export function isHeavyFile(p: string): boolean {
  const segs = p.split("/");
  return segs.pop() === ".DS_Store" || segs.some((seg) => HEAVY_DIRS.has(seg));
}

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

  /** Bumped by invalidate(): a build that started before it must not store its (stale) result. */
  private gen = 0;

  /** Forces a full rebuild on the next request. */
  invalidate() {
    this.gen++;
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
    // A build that an invalidate() overtook does not store its result (it may have walked past a
    // new file): walk again, a few times at most, so a tree that never settles still gets a list.
    for (let tries = 0; !this.files; tries++) {
      const gen = this.gen;
      const set = await (this.building ??= this.build());
      if (this.gen === gen || tries >= 3) {
        this.files ??= set;
        this.building = null;
      }
    }
    return (this.text ??= [...this.files!].join("\n"));
  }

  /**
   * Applies watcher paths incrementally. Returns true when the set of files changed
   * (created/deleted/renamed); plain content edits return false.
   */
  async apply(paths: string[]): Promise<boolean> {
    const files = this.files;
    if (!files) {
      // A build in progress may already have walked past these paths (heavy dirs it never walks
      // do not count: a running build would restart on every event under target/ or .venv/).
      if (this.building && paths.some((p) => !p.split("/").some((seg) => HEAVY_DIRS.has(seg)))) this.invalidate();
      return true;
    }
    if (paths.length > 2000) {
      this.invalidate();
      return true;
    }
    let changed = false;
    // Directories as they were before this batch: only a path that was one can have files below it.
    const dirs = this.knownDirs();
    await Promise.all(
      paths.map(async (p) => {
        if (p.includes("\n") || p.split("/").some((seg) => HEAVY_DIRS.has(seg))) return;
        const abs = path.join(this.root, p);
        const st = await stat(abs).catch(() => null);
        if (st?.isDirectory()) {
          // Events for known directories are just content churn inside them. A new (or
          // moved-in) directory may hold many files: rescan from scratch.
          if (!this.knownDirs().has(p)) {
            // Unless it is a symlink out of the root, which build() never lists.
            if (!(await this.inside(abs))) return;
            this.invalidate();
            changed = true;
          }
          return;
        }
        // No longer a directory (deleted, or replaced by a file in one burst, which the watcher
        // can report as a single event for the path): drop everything under it. Only for a known
        // directory: scanning every file for every deleted path froze the server for 20 s on a
        // 1 500-file `rm`.
        if (dirs.has(p)) for (const f of files) if (f.startsWith(p + "/")) {
          files.delete(f);
          changed = true;
        }
        if (st && !files.has(p)) {
          // Like build(): a new symlink to a file outside the root is never listed.
          if (!(await this.inside(abs))) return;
          files.add(p);
          this.dirs = null;
          changed = true;
        } else if (!st) {
          if (files.delete(p)) changed = true;
        }
      }),
    );
    if (changed) {
      this.text = null;
      this.dirs = null; // a deleted directory recreated later must be walked again
    }
    return changed;
  }

  private rootReal: Promise<string> | null = null;

  /** True when `abs` resolves to the root or somewhere beneath it (symlinks followed). */
  private async inside(abs: string): Promise<boolean> {
    const root = await (this.rootReal ??= realpath(this.root).catch(() => this.root));
    const real = await realpath(abs).catch(() => null);
    return real !== null && (real === root || real.startsWith(root + path.sep));
  }

  private async build(): Promise<Set<string>> {
    const out: string[] = [];
    const root = await (this.rootReal ??= realpath(this.root).catch(() => this.root));
    // Realpaths reached through a symlink: a link to its own ancestor, or a second link to the
    // same target, is not walked again (real directories always are).
    const linked = new Set<string>();
    // Breadth-first so shallow files win when the cap is hit.
    let level: { rel: string; real: string }[] = [{ rel: "", real: root }];
    while (level.length && out.length < MAX_FILES) {
      const next: typeof level = [];
      await Promise.all(
        level.map(async ({ rel, real }) => {
          let dirents;
          try {
            dirents = await readdir(path.join(this.root, rel), { withFileTypes: true });
          } catch {
            return;
          }
          for (const d of dirents) {
            // The list is newline separated: such a name cannot be in it (it read as two entries).
            if (d.name.includes("\n")) continue;
            const p = rel ? rel + "/" + d.name : d.name;
            if (d.isSymbolicLink()) {
              // Symlinks are followed only inside the root: a link to ~ or / is neither listed nor walked.
              const abs = path.join(this.root, p);
              const target = await realpath(abs).catch(() => null);
              if (!target || !(target === root || target.startsWith(root + path.sep))) continue;
              const st = await stat(abs).catch(() => null);
              if (!st) continue;
              if (!st.isDirectory()) {
                if (out.length < MAX_FILES) out.push(p);
              } else if (!HEAVY_DIRS.has(d.name) && !linked.has(target) && real !== target && !real.startsWith(target + path.sep)) {
                linked.add(target);
                next.push({ rel: p, real: target });
              }
            } else if (d.isDirectory()) {
              if (!HEAVY_DIRS.has(d.name)) next.push({ rel: p, real: real + path.sep + d.name });
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
