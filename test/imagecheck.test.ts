import { expect, test } from "bun:test";
import { imageRefusal, imageSize, MAX_SVG_USES, svgUseExpansion } from "../src/client/imagecheck.ts";

const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

test("image sizes are read from the header of each format", () => {
  expect(imageSize(png(640, 480))).toEqual({ w: 640, h: 480 });
  expect(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]))).toEqual({ w: 800, h: 600 });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(imageSize(jpeg)).toEqual({ w: 640, h: 480 });
  const webp = new Uint8Array(30);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  webp.set([0x0f, 0x27, 0x00, 0x0f, 0x27, 0x00], 24); // 9999+1 each
  expect(imageSize(webp)).toEqual({ w: 10000, h: 10000 });
  expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
});

test("a decompression bomb is refused, an ordinary image is not", () => {
  expect(imageRefusal(png(20000, 20000), "image/png")).toMatch(/too large/);
  expect(imageRefusal(png(4000, 3000), "image/png")).toBeNull();
});

test("SVG <use> bombs are refused, ordinary reuse is not", () => {
  // 6 levels of 10 references: a million elements from 1.6 KB.
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><rect id="l0" width="1" height="1"/>';
  for (let lvl = 1; lvl <= 6; lvl++) svg += `<g id="l${lvl}">${`<use xlink:href="#l${lvl - 1}"/>`.repeat(10)}</g>`;
  svg += '</defs><use href="#l6"/></svg>';
  expect(svgUseExpansion(svg)).toBeGreaterThan(MAX_SVG_USES);
  expect(imageRefusal(new TextEncoder().encode(svg), "image/svg+xml")).toMatch(/too many/);
  // A cycle is refused too.
  expect(svgUseExpansion('<svg><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g><use href="#a"/></svg>')).toBeGreaterThan(MAX_SVG_USES);
  // Icons reusing a symbol a few dozen times are fine.
  const icons = `<svg><defs><symbol id="s"><circle r="1"/></symbol></defs>${'<use href="#s"/>'.repeat(50)}</svg>`;
  expect(svgUseExpansion(icons)).toBe(50);
  expect(imageRefusal(new TextEncoder().encode(icons), "image/svg+xml")).toBeNull();
});
