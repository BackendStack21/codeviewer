// Image copy orchestration: layout -> render -> clipboard / native / download. Deps are injected.
import type { Span } from "./highlight.ts";
import { fitScale, layoutImage, type ImageLayout, type ImageTheme, type LayoutOptions } from "./imagelayout.ts";
import { textOf, type SelRange } from "./selection.ts";

export const MSG_OK = "Copied as image";
export const MSG_TOO_LARGE = "Selection too large for an image";
export const MSG_DOWNLOADED = "Clipboard unavailable: image downloaded";
export const MSG_FAILED = "Could not create image; copied text instead";
export const MSG_NO_SELECTION = "Nothing selected";

export type CopyResult = "native" | "clipboard" | "downloaded" | "failed";

export interface CopyImageDeps {
  renderPng(layout: ImageLayout, scale: number): Promise<Blob>;
  clipboard?: { write?(items: unknown[]): Promise<void>; ClipboardItem?: new (data: Record<string, Promise<Blob>>) => unknown };
  download(blob: Blob, name: string): void;
  native?: (png: Blob) => Promise<void>;
  copyText(text: string): Promise<void> | void;
  notify(msg: string): void;
}
export interface CopyImageInput {
  lines: string[];
  tokens: Span[][];
  theme: ImageTheme;
  range: SelRange;
  dpr: number;
  opts?: LayoutOptions;
}

const FILE_NAME = "selection.png";

/** Writes a PNG (as a promise, so the ClipboardItem can be built inside the user gesture). */
export async function copyPng(deps: CopyImageDeps, png: Promise<Blob>): Promise<CopyResult> {
  const { clipboard } = deps;
  png.catch(() => {}); // failures are handled below; this only keeps an early rejection from reading as unhandled
  // ClipboardItem and write() are both called before any await: browsers only accept them while the user gesture is live.
  let write: Promise<void> | undefined;
  if (!deps.native && clipboard?.ClipboardItem && clipboard.write) {
    try {
      write = clipboard.write([new clipboard.ClipboardItem({ "image/png": png })]);
    } catch (e) {
      write = Promise.reject(e);
    }
  }
  if (write) {
    try {
      await write;
      await png; // a render failure must not read as success even if write() ignored it
      return "clipboard";
    } catch {
      /* fall through to download */
    }
  }
  let blob: Blob;
  try {
    blob = await png;
  } catch {
    return "failed";
  }
  if (deps.native) {
    try {
      await deps.native(blob);
      return "native";
    } catch {
      /* fall through to download */
    }
  }
  deps.download(blob, FILE_NAME);
  return "downloaded";
}

/** Copies the range as an image; returns (and notifies) the user-facing message. */
export async function copyCodeImage(deps: CopyImageDeps, input: CopyImageInput): Promise<string> {
  const done = (msg: string) => {
    deps.notify(msg);
    return msg;
  };
  const layout = layoutImage(input.lines, input.tokens, input.theme, input.range, input.opts);
  if ("tooLarge" in layout) return done(MSG_TOO_LARGE);
  const fit = fitScale(layout.width, layout.height, input.dpr);
  if ("tooLarge" in fit) return done(MSG_TOO_LARGE);
  const result = await copyPng(deps, deps.renderPng(layout, fit.scale));
  if (result === "failed") {
    try {
      await deps.copyText(textOf(input.lines, input.range));
    } catch {
      /* nothing more to try */
    }
    return done(MSG_FAILED);
  }
  return done(result === "downloaded" ? MSG_DOWNLOADED : MSG_OK);
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Viewport {
  width: number;
  height: number;
}

/** Union of the selection's client rects, clamped to the visible viewport (CSS px); null when nothing visible remains. */
export function clampSnapRect(rects: RectLike[], vp: Viewport): SnapRect | null {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const q of rects) {
    if (!(q.width > 0 && q.height > 0)) continue;
    l = Math.min(l, q.left);
    t = Math.min(t, q.top);
    r = Math.max(r, q.left + q.width);
    b = Math.max(b, q.top + q.height);
  }
  l = Math.max(l, 0);
  t = Math.max(t, 0);
  r = Math.min(r, vp.width);
  b = Math.min(b, vp.height);
  if (!(r > l && b > t)) return null;
  return { x: l, y: t, w: r - l, h: b - t };
}

export interface SnapshotDeps {
  /** Native WKWebView snapshot of a viewport rect; resolves true when the PNG reached the pasteboard. */
  snapshot?: (r: SnapRect, id?: number) => Promise<boolean>;
  /** Starts a request: returns its id (supersedes any pending one) and makes it the owner of the highlight hide. */
  begin?: () => number;
  /** Hides (true) / restores (false) the selection highlight; a restore by a request that no longer owns the hide is ignored. */
  hideSelection(on: boolean, id?: number): void;
}

/** Tries the native snapshot of the selection rects; true only when it succeeded. Always restores the highlight. */
export async function copyViaSnapshot(deps: SnapshotDeps, rects: RectLike[], vp: Viewport): Promise<boolean> {
  const rect = deps.snapshot ? clampSnapRect(rects, vp) : null;
  if (!deps.snapshot || !rect) return false;
  const id = deps.begin?.();
  deps.hideSelection(true, id);
  try {
    return (await deps.snapshot(rect, id)) === true;
  } catch {
    return false;
  } finally {
    deps.hideSelection(false, id);
  }
}

/** copyPng, then (only when the PNG could not be produced) the native snapshot fallback. */
export async function copyPngOrSnapshot(
  deps: CopyImageDeps & SnapshotDeps,
  png: Promise<Blob>,
  rects: RectLike[],
  vp: Viewport,
): Promise<CopyResult | "snapshot"> {
  const res = await copyPng(deps, png);
  if (res === "failed" && (await copyViaSnapshot(deps, rects, vp))) return "snapshot";
  return res;
}

export interface SnapTracker {
  /** Starts a request: returns a fresh id and makes it the only pending one. */
  begin(): number;
  /** True exactly once for the pending id; stale, unknown, repeated or non-number ids are ignored. */
  accept(id: unknown): boolean;
  /** Cancels the pending request (or only `id`, when given and still pending): returns its id so the native side can be told, undefined otherwise. */
  cancel(id?: number): number | undefined;
  /** Makes `id` the owner of the selection hide (a newer claim takes it over). */
  claimHide(id: number): void;
  /** True only when `id` still owns the hide (then ownership is dropped): a superseded request must not un-hide. */
  releaseHide(id: number): boolean;
}
export function snapTracker(): SnapTracker {
  let next = 1;
  let pending: number | undefined;
  let hideOwner: number | undefined;
  return {
    begin: () => (pending = next++),
    accept(id) {
      if (typeof id !== "number" || id !== pending) return false;
      pending = undefined;
      return true;
    },
    cancel(id) {
      if (id !== undefined && id !== pending) return undefined;
      const cur = pending;
      pending = undefined;
      return cur;
    },
    claimHide(id) {
      hideOwner = id;
    },
    releaseHide(id) {
      if (id !== hideOwner) return false;
      hideOwner = undefined;
      return true;
    },
  };
}
