// Checks run on an image's bytes before the browser decodes or renders it. Repository images are
// untrusted: a 389 KB PNG declared 20000×20000 pixels (2 GB decoded), and a 1.6 KB SVG of nested
// <use> references expanded to a million elements and hung the page. Pure functions (tested).

/** Most pixels an image may declare (about 200 MB decoded). */
export const MAX_PIXELS = 50_000_000;
/** Most elements an SVG's <use> references may expand to. */
export const MAX_SVG_USES = 10_000;

/** Width and height from a PNG, GIF, JPEG, WebP or BMP header; null when unknown or unreadable. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const u32be = (o: number) => ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
  const u16le = (o: number) => b[o]! | (b[o + 1]! << 8);
  const u16be = (o: number) => (b[o]! << 8) | b[o + 1]!;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: u32be(16), h: u32be(20) }; // PNG IHDR (also APNG)
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: u16le(6), h: u16le(8) }; // GIF logical screen
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const w = Math.abs(new DataView(b.buffer, b.byteOffset).getInt32(18, true));
    const h = Math.abs(new DataView(b.buffer, b.byteOffset).getInt32(22, true));
    return { w, h }; // BMP (negative height = top-down)
  }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (kind === "VP8X") return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (kind === "VP8L") {
      const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { w: 1 + (v & 0x3fff), h: 1 + ((v >>> 14) & 0x3fff) };
    }
    if (kind === "VP8 ") return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to the first SOFn.
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) return null;
      const marker = b[o + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        o += 2;
        continue;
      }
      const len = u16be(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: u16be(o + 7), h: u16be(o + 5) };
      if (len < 2) return null;
      o += 2 + len;
    }
    return null;
  }
  return null;
}

/**
 * How many elements the SVG's <use> references expand to (an upper bound): each <use> costs one
 * plus the expansion of everything inside the element it references. Cycles and the cap stop the
 * walk early. The document is never rendered or executed here; tags are only tokenized.
 */
export function svgUseExpansion(svg: string): number {
  const uses = new Map<string, string[]>(); // element id → ids its descendant <use>s reference
  const all: string[] = []; // every <use> target in the document
  const open: { id: string | null }[] = [];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const attr = (attrs: string, name: RegExp) => name.exec(attrs)?.[1] ?? name.exec(attrs)?.[2] ?? null;
  for (let m; (m = tag.exec(svg)); ) {
    const [, close, name, attrs = "", selfClose] = m;
    if (close) {
      open.pop();
      continue;
    }
    const id = attr(attrs, /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (name!.replace(/^.*:/, "") === "use") {
      const href = attr(attrs, /\s(?:xlink:)?href\s*=\s*(?:"#([^"]*)"|'#([^']*)')/);
      if (href !== null) {
        all.push(href);
        for (const o of open) if (o.id !== null) (uses.get(o.id) ?? uses.set(o.id, []).get(o.id)!).push(href);
      }
    }
    if (!selfClose) open.push({ id });
    if (all.length > MAX_SVG_USES) return all.length;
  }
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const expand = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return MAX_SVG_USES + 1; // a cycle: browsers refuse it, so do we
    visiting.add(id);
    let n = 0;
    for (const t of uses.get(id) ?? []) {
      n += 1 + expand(t);
      if (n > MAX_SVG_USES) break;
    }
    visiting.delete(id);
    memo.set(id, n);
    return n;
  };
  let total = 0;
  for (const t of all) {
    total += 1 + expand(t);
    if (total > MAX_SVG_USES) return total;
  }
  return total;
}

/** Why an image should not be rendered, or null when it is safe to draw. */
export function imageRefusal(bytes: Uint8Array, type: string): string | null {
  if (type === "image/svg+xml") {
    return svgUseExpansion(new TextDecoder().decode(bytes)) > MAX_SVG_USES ? "This SVG references itself too many times to draw safely." : null;
  }
  const size = imageSize(bytes);
  if (size && size.w * size.h > MAX_PIXELS) return `This image is ${size.w.toLocaleString()} × ${size.h.toLocaleString()} pixels, too large to draw safely.`;
  return null;
}
