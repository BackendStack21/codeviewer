import { resolveRepoPath } from "./markdown.ts";

/** At most this many images are loaded per render; the rest show their alt text. */
export const MAX_IMAGES = 100;
/** A preview loads each image whole into memory: larger files show their alt text instead. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** What an image source in Markdown refers to. */
export type ImageTarget =
  | { kind: "repo"; path: string }
  | { kind: "remote"; href: string; host: string }
  | { kind: "none" };

/** Image types the server serves (src/server/files.ts IMAGE_MIME). */
export const IMAGE_EXT = new Set(["png", "apng", "jpg", "jpeg", "jpe", "jfif", "gif", "webp", "avif", "bmp", "ico", "svg", "tif", "tiff", "heic", "heif"]);
const NONE: ImageTarget = { kind: "none" };

/** Classifies an image source: a repo image (extension gated), a remote placeholder, or nothing. */
export function classifyImage(src: string, base: string): ImageTarget {
  const s = src.trim();
  if (!s || s.length > 4000) return NONE;
  if (s.startsWith("//")) {
    const host = /^\/\/([^/?#\\]+)/.exec(s)?.[1];
    return host ? { kind: "remote", href: "", host } : NONE;
  }
  if (/^data:/i.test(s)) return { kind: "remote", href: "", host: "" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^https?:/i.test(s)) return NONE;
    try {
      const u = new URL(s);
      return u.hostname ? { kind: "remote", href: s, host: u.hostname } : NONE;
    } catch {
      return NONE;
    }
  }
  const r = resolveRepoPath(base, s);
  if (!r) return NONE;
  const name = r.path.slice(r.path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || !IMAGE_EXT.has(name.slice(dot + 1).toLowerCase())) return NONE;
  return { kind: "repo", path: r.path };
}
