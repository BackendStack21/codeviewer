import { describe, expect, test } from "bun:test";
import { buildSvg, snapshotMarkdown, type SnapDeps, type SnapFragment } from "../src/client/mdsnap.ts";

const input = {
  html: '<p data-snap="0">a &amp; b</p>',
  styles: { p: "color:red;margin:0", "0": "font-weight:bold" } as Record<string, string>,
  fonts: [{ family: "Mono", uri: "data:font/woff2;base64,AAAA" }],
  width: 320,
  height: 120,
  bg: "#101010",
};

describe("buildSvg", () => {
  test("is a well-formed svg with a foreignObject of the given size", () => {
    const svg = buildSvg(input);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/<svg[^>]*width="320"[^>]*height="120"/);
    expect(svg).toMatch(/<foreignObject[^>]*width="320"[^>]*height="120"/);
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });
  test("inlines styles, font-face data URIs, content and theme background", () => {
    const svg = buildSvg(input);
    expect(svg).toContain("p{color:red;margin:0}");
    expect(svg).toContain('[data-snap="0"]{font-weight:bold}');
    expect(svg).toContain("@font-face");
    expect(svg).toContain("Mono");
    expect(svg).toContain("data:font/woff2;base64,AAAA");
    expect(svg).toContain("#101010");
    expect(svg).toContain("a &amp; b");
  });
  test("escapes hostile style and font values so the markup stays well-formed", () => {
    const svg = buildSvg({ ...input, styles: { "p<x": "color:red</style><script>1</script>" }, bg: 'x"><b>' });
    expect(svg).not.toContain("</style><script>");
    expect(svg).not.toContain('x"><b>');
    const opens = svg.match(/<style/g)?.length ?? 0;
    expect(svg.match(/<\/style>/g)?.length ?? 0).toBe(opens);
  });
});

const blob = new Blob(["png"], { type: "image/png" });
const frag: SnapFragment = {
  html: "<p>hi</p>",
  elements: [{ id: "root" }, { id: "p" }],
  fontUrls: { Mono: "/font.woff2" },
  width: 100,
  height: 50,
  bg: "#000",
  text: "hi",
};
function deps(over: Partial<SnapDeps> = {}, log: string[] = []): SnapDeps {
  return {
    computedStyle: (el) => {
      log.push("style:" + (el as { id: string }).id);
      return "color:blue";
    },
    loadFont: async (u) => {
      log.push("font:" + u);
      return "data:font/woff2;base64,QQ==";
    },
    loadImage: async (u) => {
      log.push("image");
      expect(u.startsWith("data:image/svg+xml")).toBe(true);
      expect(decodeURIComponent(u)).toContain("color:blue");
      expect(decodeURIComponent(u)).toContain("data:font/woff2;base64,QQ==");
      return { bmp: 1 };
    },
    toBlob: async (b, w, h) => {
      log.push(`blob:${w}x${h}`);
      expect(b).toEqual({ bmp: 1 });
      return blob;
    },
    ...over,
  };
}

describe("snapshotMarkdown", () => {
  test("resolves a PNG blob and reads every element's computed style and font", async () => {
    const log: string[] = [];
    const r = await snapshotMarkdown(deps({}, log), frag);
    expect(r).toBe(blob);
    expect(log).toContain("style:root");
    expect(log).toContain("style:p");
    expect(log).toContain("font:/font.woff2");
    expect(log).toContain("blob:100x50");
  });
  test("falls back to text when loadImage rejects", async () => {
    const r = await snapshotMarkdown(deps({ loadImage: async () => Promise.reject(new Error("onerror")) }), frag);
    expect(r).toEqual({ fallbackText: "hi" });
  });
  test("falls back to text when toBlob rejects", async () => {
    const r = await snapshotMarkdown(deps({ toBlob: async () => Promise.reject(new Error("x")) }), frag);
    expect(r).toEqual({ fallbackText: "hi" });
  });
  test("a failing font load does not fail the snapshot", async () => {
    const r = await snapshotMarkdown(deps({ loadFont: async () => Promise.reject(new Error("404")), loadImage: async () => ({ bmp: 1 }) }), frag);
    expect(r).toBe(blob);
  });
});
