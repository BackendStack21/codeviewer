import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

const IGNORED = /(^|\/)(\.git|node_modules|\.next|\.turbo|\.cache|__pycache__)(\/|$)/;

/**
 * Recursive file watcher that coalesces bursts of events (e.g. a `git checkout`
 * or an agent rewriting files) into one batch of root-relative paths.
 */
export function watchTree(root: string, onBatch: (paths: string[]) => void): () => void {
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;

  const flush = () => {
    timer = null;
    const batch = [...pending];
    pending = new Set();
    if (batch.length) onBatch(batch);
  };

  const onEvent = (_event: string, filename: string | Buffer | null) => {
    if (!filename) return;
    const rel = String(filename).split(path.sep).join("/");
    if (IGNORED.test(rel)) return;
    pending.add(rel);
    if (!timer) timer = setTimeout(flush, 60);
  };

  try {
    watcher = watch(root, { recursive: true, persistent: false }, onEvent);
  } catch {
    try {
      watcher = watch(root, { persistent: false }, onEvent);
    } catch {
      watcher = null;
    }
  }
  watcher?.on("error", () => {});

  return () => {
    watcher?.close();
    if (timer) clearTimeout(timer);
  };
}
