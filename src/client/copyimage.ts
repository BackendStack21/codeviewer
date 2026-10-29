// Image copy orchestration: layout -> render -> clipboard / native. Deps are injected.
import type { Span } from "./highlight.ts";
import { frameImage } from "./imageframe.ts";
import { layoutImage, type ImageLayout, type ImageTheme, type LayoutOptions } from "./imagelayout.ts";
import type { SelRange } from "./selection.ts";

export const MSG_OK = "Copied as image";
export const MSG_TOO_LARGE = "Selection too large for an image";
export const MSG_CLIPBOARD_FAILED = "Could not copy image to the clipboard";
export const MSG_NO_SELECTION = "Nothing selected";

export type CopyResult = "native" | "clipboard" | "failed" | "tooLarge";

/** Thrown when a framed image would exceed the pixel cap. */
export class FrameTooLargeError extends Error {
  constructor() {
    super("framed image too large");
  }
}

/** Toast message for a copy result. */
export function messageFor(res: CopyResult | "snapshot"): string {
  return res === "tooLarge" ? MSG_TOO_LARGE : res === "failed" ? MSG_CLIPBOARD_FAILED : MSG_OK;
}

export interface CopyImageDeps {
  renderPng(layout: ImageLayout, scale: number): Promise<Blob>;
  clipboard?: { write?(items: unknown[]): Promise<void>; ClipboardItem?: new (data: Record<string, Promise<Blob>>) => unknown };
  native?: (png: Blob) => Promise<void>;
  /** Text width in layout px, for ellipsising the frame title. */
  measure?: (text: string) => number;
  notify(msg: string): void;
}
export interface CopyImageInput {
  lines: string[];
  tokens: Span[][];
  theme: ImageTheme;
  range: SelRange;
  dpr: number;
  /** Active file path or name; its basename titles the frame. */
  title?: string;
  opts?: LayoutOptions;
}

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
      // write() may wrap the render error: look at the PNG promise itself
      return (await png.then(() => undefined, (e: unknown) => e)) instanceof FrameTooLargeError ? "tooLarge" : "failed";
    }
  }
  let blob: Blob;
  try {
    blob = await png;
  } catch (e) {
    return e instanceof FrameTooLargeError ? "tooLarge" : "failed";
  }
  if (deps.native) {
    try {
      await deps.native(blob);
      return "native";
    } catch {
      return "failed";
    }
  }
  return "failed";
}

/** Copies the range as an image; returns (and notifies) the user-facing message. */
export async function copyCodeImage(deps: CopyImageDeps, input: CopyImageInput): Promise<string> {
  const done = (msg: string) => {
    deps.notify(msg);
    return msg;
  };
  const layout = layoutImage(input.lines, input.tokens, input.theme, input.range, input.opts);
  if ("tooLarge" in layout) return done(MSG_TOO_LARGE);
  const size = input.theme.size;
  const measure = deps.measure ?? ((t: string) => t.length * size * 0.6);
  const framed = frameImage(layout, input.title ?? "", input.theme, measure, input.dpr);
  if ("tooLarge" in framed) return done(MSG_TOO_LARGE);
  const result = await copyPng(deps, deps.renderPng(framed, framed.scale));
  return done(messageFor(result));
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
  snapshot?: (r: SnapRect, id?: number) => Promise<string | null>;
  /** Frames the decoded snapshot PNG (CSS-px rect it covers) into the snippet card. */
  compose?: (png: Blob, rect: SnapRect) => Promise<Blob>;
  /** Writes a PNG to the native pasteboard. */
  native?: (png: Blob) => Promise<void>;
  /** Starts a request: returns its id (supersedes any pending one) and makes it the owner of the highlight hide. */
  begin?: () => number;
  /** Hides (true) / restores (false) the selection highlight; a restore by a request that no longer owns the hide is ignored. */
  hideSelection(on: boolean, id?: number): void;
}

/** Decodes base64 PNG data into an image/png blob. */
export function pngFromBase64(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

/** Tries the native snapshot of the selection rects (base64 PNG), frames it and writes it through the native pasteboard; true only when it all succeeded. Always restores the highlight. */
export async function copyViaSnapshot(deps: SnapshotDeps, rects: RectLike[], vp: Viewport): Promise<boolean | "tooLarge"> {
  const rect = deps.snapshot ? clampSnapRect(rects, vp) : null;
  if (!deps.snapshot || !rect) return false;
  const { compose, native } = deps;
  const id = deps.begin?.();
  deps.hideSelection(true, id);
  let b64: string | null;
  try {
    b64 = await deps.snapshot(rect, id);
  } catch {
    b64 = null;
  } finally {
    deps.hideSelection(false, id);
  }
  if (typeof b64 !== "string" || !b64 || !compose || !native) return false;
  try {
    await native(await compose(pngFromBase64(b64), rect));
    return true;
  } catch (e) {
    return e instanceof FrameTooLargeError ? "tooLarge" : false;
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
  if (res !== "failed") return res; // tooLarge would not fit through the snapshot either
  const snap = await copyViaSnapshot(deps, rects, vp);
  return snap === true ? "snapshot" : snap === "tooLarge" ? "tooLarge" : res;
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
