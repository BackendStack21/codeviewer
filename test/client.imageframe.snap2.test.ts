import { describe, expect, test } from "bun:test";
import {
  FrameTooLargeError,
  MSG_CLIPBOARD_FAILED,
  MSG_OK,
  MSG_TOO_LARGE,
  copyPng,
  copyPngOrSnapshot,
  copyViaSnapshot,
  messageFor,
  type CopyImageDeps,
  type SnapshotDeps,
} from "../src/client/copyimage.ts";
import { frameGeometry, frameOps, frameSnapshot, glyphCells } from "../src/client/imageframe.ts";
import type { ImageTheme } from "../src/client/imagelayout.ts";

const theme: ImageTheme = { bg: "#101010", fg: "#eeeeee", muted: "#8a8a8a", accent: "#4f8cff", tokenColors: {}, font: "JetBrains Mono", size: 13 };
const measure = (s: string) => s.length * 7;

describe("R-01 combining marks share their base cell", () => {
  test("a combining accent is drawn with its base character in one op", () => {
    expect(glyphCells("éx", 0, 10)).toEqual([
      { ch: "é", x: 0 },
      { ch: "x", x: 10 },
    ]);
  });
  test("a variation selector and a ZWJ sequence stay with their base glyph", () => {
    expect(glyphCells("❤️a", 0, 10)).toEqual([
      { ch: "❤️", x: 0 },
      { ch: "a", x: 10 },
    ]);
    expect(glyphCells("\u{1f468}‍\u{1f469}b", 0, 10)).toEqual([
      { ch: "\u{1f468}‍\u{1f469}", x: 0 },
      { ch: "b", x: 40 },
    ]);
  });
  test("a leading zero-width mark with no base still gets its own op at the start", () => {
    expect(glyphCells("́a", 5, 10)).toEqual([
      { ch: "́", x: 5 },
      { ch: "a", x: 5 },
    ]);
  });
});

describe("R-02 frameSnapshot takes no dpr", () => {
  test("five parameters", () => {
    expect(frameSnapshot.length).toBe(5);
  });
});

describe("R-03 a too-large frame is reported as too large", () => {
  const blob = new Blob(["png"], { type: "image/png" });
  const mkDeps = (over: Partial<CopyImageDeps & SnapshotDeps> = {}): CopyImageDeps & SnapshotDeps => ({
    renderPng: async () => blob,
    native: async () => {},
    notify: () => {},
    hideSelection: () => {},
    ...over,
  });
  const rects = [{ left: 5, top: 5, width: 100, height: 20 }];
  const vp = { width: 800, height: 600 };
  const tooLarge = () => Promise.reject(new FrameTooLargeError());

  test("copyPng maps a FrameTooLargeError rejection to tooLarge, other errors to failed", async () => {
    expect(await copyPng(mkDeps(), tooLarge())).toBe("tooLarge");
    expect(await copyPng(mkDeps(), Promise.reject(new Error("x")))).toBe("failed");
  });
  test("copyPngOrSnapshot reports tooLarge without trying the snapshot", async () => {
    let asked = false;
    const deps = mkDeps({ snapshot: async () => ((asked = true), btoa("PNG")), compose: async (p) => p });
    expect(await copyPngOrSnapshot(deps, tooLarge(), rects, vp)).toBe("tooLarge");
    expect(asked).toBe(false);
  });
  test("a native snapshot whose frame is too large reports tooLarge", async () => {
    const deps = mkDeps({ snapshot: async () => btoa("PNG"), compose: tooLarge as never });
    expect(await copyViaSnapshot(deps, rects, vp)).toBe("tooLarge");
    expect(await copyPngOrSnapshot(deps, Promise.reject(new Error("x")), rects, vp)).toBe("tooLarge");
  });
  test("messageFor", () => {
    expect(messageFor("tooLarge")).toBe(MSG_TOO_LARGE);
    expect(messageFor("failed")).toBe(MSG_CLIPBOARD_FAILED);
    expect(messageFor("clipboard")).toBe(MSG_OK);
    expect(messageFor("native")).toBe(MSG_OK);
    expect(messageFor("snapshot")).toBe(MSG_OK);
  });
});

describe("R-04 the title is drawn as one measured run", () => {
  test("frameOps marks the title text op whole", () => {
    const g = frameGeometry(500, 200, "/a/app.ts", { bg: "#101010", fg: "#eee", muted: "#888", accent: "#4f8cff" }, measure);
    if ("tooLarge" in g) throw new Error("unexpected");
    const title = frameOps(g).filter((o) => o.t === "text");
    expect(title).toHaveLength(1);
    expect((title[0] as { whole?: boolean }).whole).toBe(true);
  });
  test("frameSnapshot's title op is whole too", () => {
    const r = frameSnapshot(500, 200, "doc.md", theme, measure);
    expect("tooLarge" in r).toBe(false);
    const ops = (r as { ops: { t: string; whole?: boolean }[] }).ops.filter((o) => o.t === "text");
    expect(ops.map((o) => o.whole)).toEqual([true]);
  });
});
