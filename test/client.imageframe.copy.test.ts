import { describe, expect, test } from "bun:test";
import { copyCodeImage, MSG_OK, type CopyImageDeps } from "../src/client/copyimage.ts";
import { BACKDROP_PAD, MIN_CONTENT_W, TITLE_BAR_H } from "../src/client/imageframe.ts";
import type { DrawOp, ImageLayout, ImageTheme } from "../src/client/imagelayout.ts";

const theme: ImageTheme = { bg: "#101010", fg: "#eeeeee", muted: "#888888", accent: "#4f8cff", tokenColors: { k: "#ff0000" }, font: "Menlo, monospace", size: 10 };
const opts = { charW: 6, lineH: 15, padding: 10, radius: 8, tabSize: 4 };

class Item {
  constructor(public data: Record<string, Promise<Blob>>) {}
}

function run(title: string | undefined, lines: string[], tokens = lines.map(() => [] as [number, number, string][]), dpr = 2) {
  const seen: { layout?: ImageLayout; scale?: number } = {};
  const deps: CopyImageDeps = {
    renderPng: async (layout, scale) => {
      seen.layout = layout;
      seen.scale = scale;
      return new Blob(["x"]);
    },
    clipboard: { ClipboardItem: Item, write: async () => {} },
    notify: () => {},
  };
  const last = lines.length - 1;
  const p = copyCodeImage(deps, { lines, tokens, theme, range: { start: { line: 0, col: 0 }, end: { line: last, col: lines[last]!.length } }, dpr, opts, title });
  return { p, seen };
}
const texts = (l: ImageLayout) => l.ops.filter((o): o is Extract<DrawOp, { t: "text" }> => o.t === "text");

describe("copyCodeImage renders the framed snippet (AC-6, AC-10, AC-16)", () => {
  test("renderPng gets the framed layout at the outer size and scale 2", async () => {
    const { p, seen } = run("src/app.ts", ["const a = 1;"]);
    expect(await p).toBe(MSG_OK);
    const l = seen.layout!;
    expect(l.width).toBe(MIN_CONTENT_W + 2 * BACKDROP_PAD);
    expect(l.height).toBe(2 * 10 + 15 + TITLE_BAR_H + 2 * BACKDROP_PAD);
    expect(seen.scale).toBe(2);
    expect(l.font).toBe("Menlo, monospace");
    expect(l.size).toBe(10);
  });
  test("the file basename reaches the title and the dots are drawn", async () => {
    const { p, seen } = run("src/client/app.ts", ["a"]);
    await p;
    expect(texts(seen.layout!).some((o) => o.text === "app.ts")).toBe(true);
    expect(seen.layout!.ops.filter((o) => o.t === "dot")).toHaveLength(3);
  });
  test("without a title there is no title text", async () => {
    const { p, seen } = run(undefined, ["a"]);
    await p;
    expect(texts(seen.layout!).map((o) => o.text)).toEqual(["a"]);
  });
  test("tabs expand to tab stops and offsets include the card inset; no line numbers", async () => {
    const { p, seen } = run("a.ts", ["\treturn 1"], [[[1, 7, "k"]]]);
    await p;
    const ret = texts(seen.layout!).find((o) => o.text === "return")!;
    expect(ret.fill).toBe("#ff0000");
    expect(ret.x).toBe(BACKDROP_PAD + 10 + 4 * 6);
    expect(ret.y).toBe(BACKDROP_PAD + TITLE_BAR_H + 10);
    expect(texts(seen.layout!).some((o) => /^\d+$/.test(o.text))).toBe(false);
  });
  test("default text uses theme fg and the card uses theme bg", async () => {
    const { p, seen } = run("a.ts", ["plain"]);
    await p;
    expect(texts(seen.layout!).find((o) => o.text === "plain")!.fill).toBe("#eeeeee");
    expect(seen.layout!.ops.find((o) => o.t === "rect")).toMatchObject({ fill: "#101010" });
  });
  test("a measure dep is used to ellipsise the title", async () => {
    const seen: { layout?: ImageLayout } = {};
    const deps: CopyImageDeps = {
      renderPng: async (l) => ((seen.layout = l), new Blob(["x"])),
      clipboard: { ClipboardItem: Item, write: async () => {} },
      measure: (s: string) => s.length * 50,
      notify: () => {},
    };
    await copyCodeImage(deps, { lines: ["a"], tokens: [[]], theme, range: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } }, dpr: 2, opts, title: "long-name.ts" });
    const t = texts(seen.layout!).find((o) => o.text.endsWith("…"));
    expect(t).toBeDefined();
  });
});
