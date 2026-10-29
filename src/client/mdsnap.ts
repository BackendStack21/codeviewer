// Markdown selection -> PNG via an SVG foreignObject. Pure logic; browser APIs are injected.

export interface FontFace {
  family: string;
  uri: string;
}
export interface SvgInput {
  html: string;
  styles: Record<string, string>;
  fonts: FontFace[];
  width: number;
  height: number;
  bg: string;
}
export interface SnapDeps {
  computedStyle(el: unknown): string;
  loadFont(url: string): Promise<string>;
  loadImage(svgUrl: string): Promise<unknown>;
  toBlob(bitmap: unknown, width: number, height: number): Promise<Blob>;
}
export interface SnapFragment {
  html: string;
  elements: unknown[];
  fontUrls: Record<string, string>;
  width: number;
  height: number;
  bg: string;
  text: string;
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildSvg(i: SvgInput): string {
  const faces = i.fonts.map((f) => `@font-face{font-family:"${esc(f.family)}";src:url("${esc(f.uri)}")}`).join("");
  const rules = Object.entries(i.styles)
    .map(([k, css]) => `${/^\d+$/.test(k) ? `[data-snap="${k}"]` : esc(k)}{${esc(cssSafe(css))}}`)
    .join("");
  const w = Math.round(i.width);
  const h = Math.round(i.height);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;background:${esc(i.bg)}">` +
    `<style>${faces}${rules}</style>${i.html}</div></foreignObject></svg>`
  );
}

export async function snapshotMarkdown(deps: SnapDeps, f: SnapFragment): Promise<Blob | { fallbackText: string }> {
  try {
    const styles: Record<string, string> = {};
    f.elements.forEach((el, n) => {
      styles[String(n)] = deps.computedStyle(el);
    });
    const fonts: FontFace[] = [];
    await Promise.all(
      Object.entries(f.fontUrls).map(async ([family, url]) => {
        try {
          fonts.push({ family, uri: await deps.loadFont(url) });
        } catch {
          /* render with a fallback font */
        }
      }),
    );
    const svg = buildSvg({ html: f.html, styles, fonts, width: f.width, height: f.height, bg: f.bg });
    const bitmap = await deps.loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
    return await deps.toBlob(bitmap, f.width, f.height);
  } catch {
    return { fallbackText: f.text };
  }
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface TreeNode {
  children: TreeNode[];
}

/** Maps a computed font-family list to the embeddable {family,url} faces found in the table. */
export function fontFaceUrls(familyList: string, table: Record<string, string[]>): { family: string; url: string }[] {
  const byLower = new Map(Object.keys(table).map((k) => [k.toLowerCase(), k]));
  const out: { family: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const raw of familyList.split(",")) {
    const key = byLower.get(raw.trim().replace(/^["']|["']$/g, "").toLowerCase());
    if (!key || seen.has(key)) continue;
    seen.add(key);
    for (const url of table[key]!) out.push({ family: key, url });
  }
  return out;
}

/** Union of the rects plus padding on every side; zero size when there are no rects. */
export function snapSize(rects: Box[], pad: number): { width: number; height: number } {
  if (rects.length === 0) return { width: 0, height: 0 };
  const l = Math.min(...rects.map((r) => r.left));
  const t = Math.min(...rects.map((r) => r.top));
  const r = Math.max(...rects.map((x) => x.right));
  const b = Math.max(...rects.map((x) => x.bottom));
  return { width: r - l + pad * 2, height: b - t + pad * 2 };
}

/** Pairs two structurally parallel trees in pre-order (roots included); stops pairing children where counts differ. */
export function pairTrees<T extends TreeNode, U extends TreeNode>(live: T, clone: U): [T, U][] {
  const out: [T, U][] = [[live, clone]];
  const n = Math.min(live.children.length, clone.children.length);
  for (let i = 0; i < n; i++) out.push(...pairTrees(live.children[i] as T, clone.children[i] as U));
  return out;
}

/** Makes CSS text safe to place in a rule body: no braces, no markup openers. */
export function cssSafe(css: string): string {
  return css.replace(/[{}<]/g, "");
}
