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
    .map(([k, css]) => `${/^\d+$/.test(k) ? `[data-snap="${k}"]` : esc(k)}{${esc(css)}}`)
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
