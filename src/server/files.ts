import { open, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export type EntryType = "dir" | "file" | "link-broken";
export interface Entry {
  name: string;
  type: EntryType;
  link?: true;
}

export const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Image types shown in the image viewer and in Markdown previews (kept in sync with IMAGE_EXT in
 * src/client/mdimage.ts). They are only ever drawn by an <img> from a blob: URL, so an SVG never
 * runs script. TIFF and HEIC decode in the Mac app (WebKit); Chromium shows the decode notice.
 */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
};

export function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Every extension the image viewer opens. */
export const IMAGE_EXTS: readonly string[] = Object.keys(IMAGE_MIME);

export function imageMime(p: string): string | undefined {
  return IMAGE_MIME[extOf(p)];
}

/**
 * Resolves a root-relative path ("" = root, "/"-separated) to an absolute real path.
 * Returns null if the path is malformed, missing, or escapes the root (including via symlinks).
 */
export async function resolveSafe(rootReal: string, rel: string): Promise<string | null> {
  if (rel.includes("\0") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === "..")) return null;
  const joined = path.join(rootReal, ...parts);
  if (!within(rootReal, joined)) return null;
  try {
    const real = await realpath(joined);
    return within(rootReal, real) ? real : null;
  } catch {
    return null;
  }
}

export function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** OS metadata and VCS internals that are never interesting in a code tree. */
const HIDDEN = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".git", ".hg", ".svn"]);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural, case-insensitive order. ASCII names (the vast majority) skip the slow collator. */
export function compareNames(a: string, b: string): number {
  if (!/^[\x20-\x7e]*$/.test(a) || !/^[\x20-\x7e]*$/.test(b)) return collator.compare(a, b);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(j);
    if (ca >= 48 && ca <= 57 && cb >= 48 && cb <= 57) {
      // Compare whole digit runs numerically (file2 < file10).
      let ei = i;
      let ej = j;
      while (ei < a.length && a.charCodeAt(ei) >= 48 && a.charCodeAt(ei) <= 57) ei++;
      while (ej < b.length && b.charCodeAt(ej) >= 48 && b.charCodeAt(ej) <= 57) ej++;
      const na = a.slice(i, ei).replace(/^0+(?=\d)/, "");
      const nb = b.slice(j, ej).replace(/^0+(?=\d)/, "");
      if (na.length !== nb.length) return na.length - nb.length;
      if (na !== nb) return na < nb ? -1 : 1;
      i = ei;
      j = ej;
      continue;
    }
    if (ca >= 65 && ca <= 90) ca += 32;
    if (cb >= 65 && cb <= 90) cb += 32;
    if (ca !== cb) return ca - cb;
    i++;
    j++;
  }
  return a.length - i - (b.length - j);
}

export async function listDir(abs: string): Promise<Entry[]> {
  const dirents = (await readdir(abs, { withFileTypes: true })).filter((d) => !HIDDEN.has(d.name));
  const out: Entry[] = await Promise.all(
    dirents.map(async (d): Promise<Entry> => {
      if (d.isSymbolicLink()) {
        try {
          const s = await stat(path.join(abs, d.name));
          return { name: d.name, type: s.isDirectory() ? "dir" : "file", link: true };
        } catch {
          return { name: d.name, type: "link-broken", link: true };
        }
      }
      return { name: d.name, type: d.isDirectory() ? "dir" : "file" };
    }),
  );
  out.sort((a, b) => {
    const ad = a.type === "dir" ? 0 : 1;
    const bd = b.type === "dir" ? 0 : 1;
    return ad - bd || compareNames(a.name, b.name);
  });
  return out;
}

export interface FileMeta {
  kind: "text" | "image" | "binary" | "dir";
  size: number;
  mtime: number;
  truncated: boolean;
  encoding?: string;
}

/** Heuristic used by git & friends: NUL in the first 8KB means binary (UTF-16 BOMs excepted). */
export function looksBinary(buf: Uint8Array): boolean {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Opens a resolved path for reading, safely: never follows a symlink swapped in after
 * resolveSafe() (O_NOFOLLOW), never blocks on FIFOs/devices (O_NONBLOCK), and refuses
 * anything that isn't a regular file.
 */
export async function openRegular(abs: string) {
  const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const st = await fh.stat();
  if (!st.isFile()) {
    await fh.close();
    throw new Error("not a regular file");
  }
  return { fh, st };
}

export async function readForView(abs: string, forceText = false): Promise<{ meta: FileMeta; body?: Uint8Array }> {
  const s0 = await stat(abs);
  if (s0.isDirectory()) return { meta: { kind: "dir", size: s0.size, mtime: s0.mtimeMs, truncated: false } };
  const { fh, st: s } = await openRegular(abs);
  const meta: FileMeta = { kind: "text", size: s.size, mtime: s.mtimeMs, truncated: false };
  if (imageMime(abs) && !forceText) {
    await fh.close();
    return { meta: { ...meta, kind: "image" } };
  }
  const len = Math.min(s.size, MAX_TEXT_BYTES);
  try {
    const buf = new Uint8Array(len);
    let off = 0;
    while (off < len) {
      const { bytesRead } = await fh.read(buf, off, len - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    let body = buf.subarray(0, off);
    if (looksBinary(body)) return { meta: { ...meta, kind: "binary" } };
    meta.truncated = s.size > len;
    // UTF-16 (BOM) is transcoded so the client always receives UTF-8.
    if (body.length >= 2 && ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff))) {
      const le = body[0] === 0xff;
      meta.encoding = le ? "UTF-16 LE" : "UTF-16 BE";
      body = new TextEncoder().encode(new TextDecoder(le ? "utf-16le" : "utf-16be").decode(body.subarray(2)));
    } else if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
      meta.encoding = "UTF-8 with BOM";
      body = body.subarray(3);
    }
    return { meta, body };
  } finally {
    await fh.close();
  }
}

export function toRel(rootReal: string, abs: string): string | null {
  const resolved = path.resolve(abs);
  if (!within(rootReal, resolved)) return null;
  return path.relative(rootReal, resolved).split(path.sep).join("/");
}
