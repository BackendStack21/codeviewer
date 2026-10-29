// Markdown selection -> PNG via an SVG foreignObject. Pure logic; browser APIs are injected.

export interface FontFace {
  family: string;
  uri: string;
  weight?: string;
  style?: string;
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
  /** Extra faces of the same families (weight/style variants), embedded alongside `fontUrls`. */
  faces?: { family: string; url: string; weight?: string; style?: string }[];
  width: number;
  height: number;
  bg: string;
  text: string;
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildSvg(i: SvgInput): string {
  const faces = i.fonts.map((f) => `@font-face{font-family:"${esc(f.family)}";src:url("${esc(f.uri)}")${f.weight ? `;font-weight:${esc(f.weight)}` : ""}${f.style ? `;font-style:${esc(f.style)}` : ""}}`).join("");
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
    await Promise.all(
      (f.faces ?? []).map(async (face) => {
        try {
          fonts.push({ family: face.family, uri: await deps.loadFont(face.url), weight: face.weight, style: face.style });
        } catch {
          /* render with a fallback face */
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

/** Abstract node: a text node has `text`, an element has `children` (empty for leaves such as img/br). */
export interface PNode {
  text?: string;
  children: PNode[];
}
export interface RangePoint<N> {
  node: N;
  offset: number;
}
export interface PrunedNode<N> {
  src: N;
  /** Trimmed text, for text nodes only. */
  text?: string;
  children: PrunedNode<N>[];
}

/**
 * Pure: computes which nodes of the tree under `root` lie inside the range, from the original (unmutated) tree.
 * Text at the boundaries is trimmed; elements with no kept descendants are dropped; the root is always kept.
 */
export function pruneToRange<N extends PNode>(root: N, start: RangePoint<N>, end: RangePoint<N>): PrunedNode<N> {
  // pre-order index of every node, plus the index just past each subtree
  const index = new Map<PNode, number>();
  const after = new Map<PNode, number>();
  let counter = 0;
  const walk = (n: PNode) => {
    index.set(n, counter++);
    for (const c of n.children) walk(c);
    after.set(n, counter);
  };
  walk(root);
  // a boundary is (node index, offset inside that node); element offsets are child indexes
  const point = (p: RangePoint<N>): [number, number] => {
    if (p.node.text !== undefined) return [index.get(p.node) ?? 0, p.offset];
    const child = p.node.children[p.offset];
    return [child ? index.get(child)! : after.get(p.node)!, 0];
  };
  const [si, so] = point(start);
  const [ei, eo] = point(end);
  const build = (n: N, isRoot: boolean): PrunedNode<N> | null => {
    const i = index.get(n)!;
    if (n.text !== undefined) {
      const from = i < si ? Infinity : i === si ? so : 0;
      const to = i > ei ? -Infinity : i === ei ? eo : n.text.length;
      const text = n.text.slice(Math.max(from, 0), Math.max(to, 0));
      return from < to && text ? { src: n, text, children: [] } : null;
    }
    if (n.children.length === 0) {
      const inside = (i > si || (i === si && so === 0)) && (i < ei || (i === ei && eo > 0));
      return inside || isRoot ? { src: n, children: [] } : null;
    }
    const kids = n.children.map((c) => build(c as N, false)).filter((k): k is PrunedNode<N> => k !== null);
    return kids.length > 0 || isRoot ? { src: n, children: kids } : null;
  };
  return build(root, true)!;
}

/** True when `src` resolves (against `base`) to the page origin or is an inline data: URI; anything else is not fetched. */
export function isInlinableImage(src: string, base: string): boolean {
  try {
    const u = new URL(src, base);
    if (u.protocol === "data:") return true;
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === new URL(base).origin;
  } catch {
    return false;
  }
}
