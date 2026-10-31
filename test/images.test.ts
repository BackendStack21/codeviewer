// Common image formats open in the image viewer, and the Mac app lets the page show them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMAGE_EXTS, imageMime, readForView } from "../src/server/files.ts";
import { IMAGE_EXT } from "../src/client/mdimage.ts";

const COMMON = ["png", "apng", "jpg", "jpeg", "jpe", "jfif", "gif", "webp", "avif", "bmp", "ico", "svg", "tif", "tiff", "heic", "heif"];

let dir = "";
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-img-")));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("image formats", () => {
  test("every common format has an image MIME type, in any letter case", () => {
    for (const ext of COMMON) {
      expect(imageMime(`a/b.${ext}`)).toStartWith("image/");
      expect(imageMime(`a/b.${ext.toUpperCase()}`)).toBe(imageMime(`a/b.${ext}`)!);
    }
    expect(imageMime("photo.JPG")).toBe("image/jpeg");
    expect(imageMime("notes.txt")).toBeUndefined();
    expect(imageMime("jpg")).toBeUndefined();
  });

  test("the Markdown preview accepts exactly the formats the server serves", () => {
    expect([...IMAGE_EXT].sort()).toEqual([...IMAGE_EXTS].sort());
  });

  test("a JPEG opens as an image, not as text or binary", async () => {
    // SOI + APP0 "JFIF" header: binary bytes that would otherwise sniff as a binary file.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0, 0, 0xff, 0xd9]);
    for (const name of ["photo.jpg", "photo.JPEG", "scan.jfif", "shot.tiff", "pic.heic"]) {
      await writeFile(path.join(dir, name), jpeg);
      expect((await readForView(path.join(dir, name))).meta.kind).toBe("image");
    }
  });
});

describe("Mac app content rules", () => {
  // Images reach <img> as blob: URLs (they are fetched with the auth header first), so the
  // window's block-everything rule list must let its own origin's blob: URLs through, and
  // nothing else new.
  test("allow only this window's http, ws and blob:http origin", async () => {
    const swift = await readFile(path.join(import.meta.dir, "../packaging/macos/main.swift"), "utf8");
    const fn = swift.match(/func contentRules\(port: Int\) -> String \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toContain(`{"trigger":{"url-filter":".*"},"action":{"type":"block"}}`);
    const allowed = [...fn.matchAll(/allow\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(allowed).toEqual(["http", "ws", "blob:http"]);
    expect(fn).toContain(`"url-filter":"^"# + scheme + #"://127\\\\.0\\\\.0\\\\.1:"# + String(port) + #"/"`);
  });
});
