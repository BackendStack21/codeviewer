import { describe, expect, test } from "bun:test";
import { copyCodeImage, copyPng, MSG_DOWNLOADED, MSG_FAILED, MSG_NO_SELECTION, MSG_OK, MSG_TOO_LARGE, type CopyImageDeps, type CopyImageInput } from "../src/client/copyimage.ts";
import type { ImageTheme } from "../src/client/imagelayout.ts";

const theme: ImageTheme = { bg: "#000", fg: "#fff", tokenColors: {}, font: "monospace", size: 10 };
const range = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, col: sc }, end: { line: el, col: ec } });
const blob = new Blob(["png"], { type: "image/png" });

function mk(over: Partial<CopyImageDeps> = {}, log: string[] = []) {
  class Item {
    constructor(public data: Record<string, Promise<Blob>>) {
      log.push("item");
    }
  }
  const deps: CopyImageDeps = {
    renderPng: async () => {
      log.push("render");
      return blob;
    },
    clipboard: {
      ClipboardItem: Item,
      write: async (items) => {
        log.push(`write:${items.length}`);
      },
    },
    download: (_b, name) => void log.push(`download:${name}`),
    copyText: (t) => void log.push(`text:${t}`),
    notify: (m) => void log.push(`notify:${m}`),
    ...over,
  };
  return { deps, log };
}
const input = (over: Partial<CopyImageInput> = {}): CopyImageInput => ({ lines: ["ab", "cd"], tokens: [[], []], theme, range: range(0, 0, 1, 2), dpr: 2, ...over });

describe("messages (AC-7b)", () => {
  test("exact strings", () => {
    expect(MSG_OK).toBe("Copied as image");
    expect(MSG_TOO_LARGE).toBe("Selection too large for an image");
    expect(MSG_DOWNLOADED).toBe("Clipboard unavailable: image downloaded");
    expect(MSG_FAILED).toBe("Could not create image; copied text instead");
    expect(MSG_NO_SELECTION).toBe("Nothing selected");
  });
});

describe("copyPng (AC-8)", () => {
  test("creates the ClipboardItem and calls write synchronously, before any await", () => {
    const { deps, log } = mk();
    void copyPng(deps, Promise.resolve(blob));
    expect(log).toEqual(["item", "write:1"]);
  });
  test("writes one item and reports clipboard", async () => {
    const { deps, log } = mk();
    expect(await copyPng(deps, Promise.resolve(blob))).toBe("clipboard");
    expect(log).toEqual(["item", "write:1"]);
  });
  test("missing ClipboardItem downloads", async () => {
    const { deps, log } = mk({ clipboard: { write: async () => {} } });
    expect(await copyPng(deps, Promise.resolve(blob))).toBe("downloaded");
    expect(log.filter((l) => l.startsWith("download"))).toHaveLength(1);
  });
  test("missing clipboard or write downloads", async () => {
    const a = mk({ clipboard: undefined });
    expect(await copyPng(a.deps, Promise.resolve(blob))).toBe("downloaded");
    const b = mk({ clipboard: { ClipboardItem: class {} as never } });
    expect(await copyPng(b.deps, Promise.resolve(blob))).toBe("downloaded");
  });
  test("write rejection falls back to download", async () => {
    const { deps, log } = mk({
      clipboard: {
        ClipboardItem: class {} as never,
        write: async () => {
          throw new Error("denied");
        },
      },
    });
    expect(await copyPng(deps, Promise.resolve(blob))).toBe("downloaded");
    expect(log).toHaveLength(1);
    expect(log[0]).toStartWith("download:");
  });
  test("native handler is preferred over the clipboard", async () => {
    const got: Blob[] = [];
    const { deps, log } = mk({ native: async (b) => void got.push(b) });
    expect(await copyPng(deps, Promise.resolve(blob))).toBe("native");
    expect(got).toEqual([blob]);
    expect(log.some((l) => l.startsWith("write"))).toBe(false);
  });
  test("native failure falls back to download", async () => {
    const { deps, log } = mk({
      native: async () => {
        throw new Error("x");
      },
    });
    expect(await copyPng(deps, Promise.resolve(blob))).toBe("downloaded");
    expect(log.filter((l) => l.startsWith("download"))).toHaveLength(1);
  });
  test("a rejected render promise reports failed without download", async () => {
    const { deps, log } = mk();
    const p = Promise.reject(new Error("render"));
    expect(await copyPng(deps, p)).toBe("failed");
    expect(log.some((l) => l.startsWith("download"))).toBe(false);
  });
});

describe("copyCodeImage (AC-4, AC-7)", () => {
  test("success renders at min(dpr,2) and reports MSG_OK", async () => {
    const scales: number[] = [];
    const { deps, log } = mk({
      renderPng: async (_l, s) => {
        scales.push(s);
        return blob;
      },
    });
    expect(await copyCodeImage(deps, input({ dpr: 3 }))).toBe("Copied as image");
    expect(scales).toEqual([2]);
    expect(log).toContain("notify:Copied as image");
  });
  test("renders synchronously inside the gesture (ClipboardItem built before await)", () => {
    const { deps, log } = mk();
    void copyCodeImage(deps, input());
    expect(log).toEqual(["render", "item", "write:1"]);
  });
  test("layout receives the laid out size", async () => {
    let w = 0;
    const { deps } = mk({
      renderPng: async (l) => {
        w = l.width;
        return blob;
      },
    });
    await copyCodeImage(deps, input({ opts: { charW: 6, padding: 10, lineH: 15 } }));
    expect(w).toBe(2 * 10 + 2 * 6);
  });
  test("too many rows reports too large and never touches the clipboard", async () => {
    const lines = Array.from({ length: 20001 }, () => "x");
    const { deps, log } = mk();
    const msg = await copyCodeImage(deps, input({ lines, tokens: [], range: range(0, 0, 20000, 1) }));
    expect(msg).toBe("Selection too large for an image");
    expect(log).toEqual(["notify:Selection too large for an image"]);
  });
  test("area beyond the pixel cap reports too large", async () => {
    const lines = Array.from({ length: 5000 }, () => "x".repeat(3000));
    const { deps, log } = mk();
    const msg = await copyCodeImage(deps, input({ lines, tokens: [], range: range(0, 0, 4999, 3000) }));
    expect(msg).toBe("Selection too large for an image");
    expect(log.some((l) => l === "item" || l.startsWith("write") || l === "render")).toBe(false);
  });
  test("clipboard unavailable reports the download message", async () => {
    const { deps } = mk({ clipboard: undefined });
    expect(await copyCodeImage(deps, input())).toBe("Clipboard unavailable: image downloaded");
  });
  test("render failure copies plain text and reports MSG_FAILED", async () => {
    const { deps, log } = mk({
      renderPng: async () => {
        throw new Error("canvas");
      },
    });
    expect(await copyCodeImage(deps, input({ range: range(0, 1, 1, 1) }))).toBe("Could not create image; copied text instead");
    expect(log).toContain("text:b\nc");
    expect(log).toContain("notify:Could not create image; copied text instead");
  });
});
