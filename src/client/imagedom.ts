// Thin browser glue for image copy (canvas, clipboard, native bridge). Verified manually.
import { snapTracker, type CopyImageDeps, type SnapRect, type SnapshotDeps } from "./copyimage.ts";
import { isInlinableImage, pruneToRange, snapFaces, snapSize, type PNode, type PrunedNode, type SnapDeps, type SnapFragment } from "./mdsnap.ts";
import { canvasFont, fontLoadSpecs, glyphCells, scaledShadow } from "./imageframe.ts";
import type { ImageLayout } from "./imagelayout.ts";

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderLayoutPng(layout: ImageLayout, scale: number, font: string, size: number): Promise<Blob> {
  font = layout.font ?? font;
  size = layout.size ?? size;
  try {
    await Promise.all(fontLoadSpecs(layout.ops, font, size).map((f) => document.fonts.load(f)));
  } catch {
    /* draw with whatever font is available */
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(layout.width * scale);
  canvas.height = Math.ceil(layout.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";
  for (const op of layout.ops) {
    if (op.t === "gradient") {
      const g = ctx.createLinearGradient(op.x0, op.y0, op.x1, op.y1);
      for (const st of op.stops) g.addColorStop(st.at, st.color);
      ctx.fillStyle = g;
      ctx.fillRect(op.x, op.y, op.w, op.h);
    } else if (op.t === "rect") {
      ctx.save();
      if (op.shadow) {
        ctx.shadowColor = op.shadow.color;
        const sh = scaledShadow(op.shadow, scale);
        ctx.shadowBlur = sh.blur;
        ctx.shadowOffsetY = sh.offsetY;
      }
      ctx.fillStyle = op.fill;
      roundRect(ctx, op.x, op.y, op.w, op.h, op.r);
      ctx.fill();
      ctx.restore();
    } else if (op.t === "dot") {
      ctx.fillStyle = op.fill;
      ctx.beginPath();
      ctx.arc(op.cx, op.cy, op.r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.font = canvasFont(font, size, op.bold, op.italic);
      ctx.fillStyle = op.fill;
      // One glyph per grid cell: the editor disables ligatures, so the image must never form them.
      const charW = layout.charW ?? size * 0.6;
      for (const g of glyphCells(op.text, op.x, charW)) ctx.fillText(g.ch, g.x, op.y);
    }
  }
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

type Bridge = { postMessage(m: unknown): void } | undefined;

export function browserDeps(opts: { font: string; size: number; bridge?: Bridge; notify(msg: string): void }): CopyImageDeps {
  const w = window as unknown as { ClipboardItem?: new (d: Record<string, Promise<Blob>>) => unknown };
  const cb = navigator.clipboard as { write?(items: unknown[]): Promise<void> } | undefined;
  const bridge = opts.bridge;
  return {
    renderPng: (layout, scale) => renderLayoutPng(layout, scale, opts.font, opts.size),
    measure: (t) => {
      const c = document.createElement("canvas").getContext("2d");
      if (!c) return t.length * opts.size * 0.6;
      c.font = `${opts.size}px ${opts.font}`;
      return c.measureText(t).width;
    },
    clipboard: cb?.write && w.ClipboardItem ? { write: (items) => cb.write!(items), ClipboardItem: w.ClipboardItem } : undefined,
    native: bridge ? async (png) => bridge.postMessage({ t: "copyimage", png: await toBase64(png) }) : undefined,
    notify: opts.notify,
  };
}

const SNAP_TIMEOUT = 3000;
const tracker = snapTracker();
let snapDone: ((ok: boolean) => void) | undefined;
if (typeof window !== "undefined") {
  (window as unknown as { __cvSnap?: (id: unknown, ok: unknown) => void }).__cvSnap = (id, ok) => {
    if (tracker.accept(id)) snapDone?.(ok === true);
  };
}

/** Snapshot fallback deps: native takeSnapshot via the bridge (reply through window.__cvSnap) and a root class hiding ::selection. */
export function snapshotDeps(bridge: Bridge): SnapshotDeps {
  const root = document.documentElement;
  const deps: SnapshotDeps = {
    begin() {
      // A new request supersedes a pending one: its late PNG must never reach the pasteboard.
      const old = tracker.cancel();
      if (old !== undefined) {
        bridge?.postMessage({ t: "snapshotcancel", id: old });
        snapDone?.(false);
      }
      const id = tracker.begin();
      tracker.claimHide(id);
      return id;
    },
    // Only the request that owns the hide may restore the highlight.
    hideSelection: (on, id) => {
      if (!on && id !== undefined && !tracker.releaseHide(id)) return;
      root.classList.toggle("snap-hide-sel", on);
    },
    snapshot: bridge
      ? (r: SnapRect, id?: number) =>
          new Promise<boolean>((res) => {
            if (id === undefined) id = deps.begin!();
            const rid = id;
            const finish = (ok: boolean) => {
              clearTimeout(timer);
              snapDone = undefined;
              res(ok);
            };
            const timer = setTimeout(() => {
              if (tracker.cancel(rid) !== undefined) bridge.postMessage({ t: "snapshotcancel", id: rid });
              finish(false);
            }, SNAP_TIMEOUT);
            snapDone = finish;
            // Give the highlight removal one frame to paint before the native side captures.
            requestAnimationFrame(() => requestAnimationFrame(() => bridge.postMessage({ t: "snapshotrect", id: rid, ...r })));
          })
      : undefined,
  };
  return deps;
}

const blobToDataUri = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(b);
  });

export const markdownSnapDeps: SnapDeps = {
  computedStyle(el) {
    const cs = getComputedStyle(el as Element);
    let out = "";
    for (let i = 0; i < cs.length; i++) out += `${cs[i]}:${cs.getPropertyValue(cs[i]!)};`;
    return out;
  },
  loadFont: async (url) => blobToDataUri(await (await fetch(url)).blob()),
  loadImage: (svgUrl) =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("svg image failed"));
      img.src = svgUrl;
    }),
  async toBlob(bitmap, width, height) {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.scale(scale, scale);
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
  },
};

const PAD = 12;

type LiveNode = PNode & { node: Node; children: LiveNode[] };
const liveTree = (n: Node, map: Map<Node, LiveNode>): LiveNode => {
  const t: LiveNode = { node: n, children: [], ...(n.nodeType === 3 ? { text: n.nodeValue ?? "" } : {}) };
  map.set(n, t);
  if (n.nodeType === 1) for (const c of Array.from(n.childNodes)) if (c.nodeType === 1 || c.nodeType === 3) t.children.push(liveTree(c, map));
  return t;
};

async function inlineImage(img: HTMLImageElement, live: HTMLImageElement) {
  try {
    const src = live.currentSrc || live.src;
    if (!isInlinableImage(src, location.href)) throw new Error("cross-origin image");
    img.setAttribute("src", await blobToDataUri(await (await fetch(src)).blob()));
    img.removeAttribute("srcset");
  } catch {
    img.removeAttribute("src");
    img.removeAttribute("srcset");
  }
}

/** Builds a pruned copy of the live subtree under the range's common ancestor as a fragment for snapshotMarkdown. */
export async function fragmentFromRange(range: Range, host: HTMLElement, bg: string): Promise<SnapFragment> {
  let root: Node = range.commonAncestorContainer;
  if (root.nodeType !== 1) root = root.parentNode ?? host;
  const map = new Map<Node, LiveNode>();
  const tree = liveTree(root, map);
  const pt = (node: Node, offset: number) => ({ node: map.get(node) ?? tree, offset });
  const pruned = pruneToRange(tree, pt(range.startContainer, range.startOffset), pt(range.endContainer, range.endOffset));
  const liveOf = new Map<Node, Node>();
  const build = (p: PrunedNode<LiveNode>): Node => {
    if (p.text !== undefined) return document.createTextNode(p.text);
    const c = p.src.node.cloneNode(false);
    liveOf.set(c, p.src.node);
    for (const k of p.children) c.appendChild(build(k));
    return c;
  };
  const cloneRoot = build(pruned) as Element;
  const wrap = document.createElement("div");
  wrap.appendChild(cloneRoot);
  const kept = [wrap, ...Array.from(wrap.querySelectorAll("*"))];
  const elements: Element[] = [host];
  const imgs: Promise<void>[] = [];
  kept.slice(1).forEach((c, n) => {
    const live = liveOf.get(c) as Element | undefined;
    elements.push(live ?? host);
    c.setAttribute("data-snap", String(n + 1));
    if (live && c.tagName === "IMG") imgs.push(inlineImage(c as HTMLImageElement, live as HTMLImageElement));
  });
  const hs = getComputedStyle(host);
  wrap.setAttribute("style", `padding:${PAD}px;box-sizing:border-box;font:${hs.font};color:${hs.color};line-height:${hs.lineHeight}`);
  await Promise.all(imgs);
  const size = snapSize(Array.from(range.getClientRects()), PAD);
  const fontFaces = snapFaces(`${getComputedStyle(host).fontFamily},JetBrains Mono,Inter`);
  return {
    html: new XMLSerializer().serializeToString(wrap),
    elements,
    fontUrls: {},
    faces: fontFaces,
    width: Math.ceil(Math.max(size.width, 1)),
    height: Math.ceil(Math.max(size.height, 1)),
    bg,
    text: range.toString(),
  };
}
