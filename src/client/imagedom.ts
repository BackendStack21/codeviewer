// Thin browser glue for image copy (canvas, clipboard, download, native bridge). Verified manually.
import type { CopyImageDeps } from "./copyimage.ts";
import type { SnapDeps, SnapFragment } from "./mdsnap.ts";
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
  try {
    await document.fonts.load(`${size}px ${font}`);
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
    if (op.t === "rect") {
      ctx.fillStyle = op.fill;
      roundRect(ctx, op.x, op.y, op.w, op.h, op.r);
      ctx.fill();
    } else {
      ctx.font = `${op.italic ? "italic " : ""}${op.bold ? "bold " : ""}${size}px ${font}`;
      ctx.fillStyle = op.fill;
      ctx.fillText(op.text, op.x, op.y);
    }
  }
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}

export function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
    clipboard: cb?.write && w.ClipboardItem ? { write: (items) => cb.write!(items), ClipboardItem: w.ClipboardItem } : undefined,
    download: downloadBlob,
    native: bridge ? async (png) => bridge.postMessage({ t: "copyimage", png: await toBase64(png) }) : undefined,
    copyText: (t) => navigator.clipboard.writeText(t),
    notify: opts.notify,
  };
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

/** Clones the range into an index-tagged fragment (element 0 is the wrapper) ready for snapshotMarkdown. */
export function fragmentFromRange(range: Range, host: HTMLElement, bg: string): SnapFragment {
  const wrap = document.createElement("div");
  wrap.appendChild(range.cloneContents());
  const live = Array.from(host.querySelectorAll("*")).filter((e) => range.intersectsNode(e));
  const clones = [wrap, ...Array.from(wrap.querySelectorAll("*"))];
  clones.forEach((c, n) => c.setAttribute("data-snap", String(n)));
  const rect = host.getBoundingClientRect();
  // clone styles come from the live elements of the same tag order; the wrapper takes the host's style
  const elements: Element[] = [host, ...live.slice(0, clones.length - 1)];
  while (elements.length < clones.length) elements.push(host);
  return {
    html: new XMLSerializer().serializeToString(wrap),
    elements,
    fontUrls: {},
    width: Math.ceil(rect.width),
    height: Math.ceil(Math.min(rect.height, host.scrollHeight)),
    bg,
    text: range.toString(),
  };
}
