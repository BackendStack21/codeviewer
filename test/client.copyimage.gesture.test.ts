import { describe, expect, test } from "bun:test";
import { copyCodeImage, copyPng, type CopyImageDeps } from "../src/client/copyimage.ts";
import type { ImageTheme } from "../src/client/imagelayout.ts";

const theme: ImageTheme = { bg: "#000", fg: "#fff", tokenColors: {}, font: "monospace", size: 10 };
const blob = new Blob(["png"], { type: "image/png" });
const range = { start: { line: 0, col: 0 }, end: { line: 1, col: 2 } };

// Realistic clipboard: write() settles with the ClipboardItem's blob promise.
function mk(log: string[], over: Partial<CopyImageDeps> = {}): CopyImageDeps {
  class Item {
    constructor(public data: Record<string, Promise<Blob>>) {}
  }
  return {
    renderPng: async () => blob,
    clipboard: {
      ClipboardItem: Item,
      write: async (items) => {
        log.push("write");
        await (items[0] as Item).data["image/png"];
      },
    },
    ...({ download: () => void log.push("download") } as object), // must never be called
    notify: (m) => void log.push(`notify:${m}`),
    ...over,
  };
}

describe("clipboard.write is called inside the gesture (R-01)", () => {
  test("copyPng calls write before the png promise resolves", () => {
    const log: string[] = [];
    let release!: (b: Blob) => void;
    const png = new Promise<Blob>((r) => (release = r));
    void copyPng(mk(log), png);
    expect(log).toEqual(["write"]);
    release(blob);
  });
  test("copyCodeImage calls render then write synchronously", () => {
    const log: string[] = [];
    const deps = mk(log, {
      renderPng: () => {
        log.push("render");
        return new Promise<Blob>(() => {});
      },
    });
    void copyCodeImage(deps, { lines: ["ab", "cd"], tokens: [[], []], theme, range, dpr: 1 });
    expect(log).toEqual(["render", "write"]);
  });
  test("a rejected png makes write reject and reports failed without download", async () => {
    const log: string[] = [];
    expect(await copyPng(mk(log), Promise.reject(new Error("render")))).toBe("failed");
    expect(log).toEqual(["write"]);
  });
  test("write rejecting while the png is fine fails without download", async () => {
    const log: string[] = [];
    const deps = mk(log, {
      clipboard: {
        ClipboardItem: class {} as never,
        write: async () => {
          log.push("write");
          throw new Error("denied");
        },
      },
    });
    expect(await copyPng(deps, Promise.resolve(blob))).toBe("failed");
    expect(log).toEqual(["write"]);
  });
  test("render failure reports the clipboard-failed message, copies no text, never downloads", async () => {
    const log: string[] = [];
    const deps = mk(log, {
      renderPng: async () => {
        throw new Error("canvas");
      },
    });
    const msg = await copyCodeImage(deps, { lines: ["ab", "cd"], tokens: [[], []], theme, range, dpr: 1 });
    expect(msg).toBe("Could not copy image to the clipboard");
    expect(log).not.toContain("download");
  });
  test("too large is decided before write is called", async () => {
    const log: string[] = [];
    const lines = Array.from({ length: 20001 }, () => "x");
    const msg = await copyCodeImage(mk(log), { lines, tokens: [], theme, range: { start: { line: 0, col: 0 }, end: { line: 20000, col: 1 } }, dpr: 1 });
    expect(msg).toBe("Selection too large for an image");
    expect(log).toEqual(["notify:Selection too large for an image"]);
  });
});
