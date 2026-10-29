import { h } from "./util.ts";

/** Text files larger than this open in source with a "Render anyway" note. */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

export interface PreviewDecision {
  /** Render the Markdown preview. */
  preview: boolean;
  /** Show the "Too large to preview" note instead. */
  tooLarge: boolean;
  /** Show the truncation pill above the preview. */
  pill: boolean;
}

export function decidePreview(size: number, truncated: boolean, forced = false): PreviewDecision {
  if (size > MAX_PREVIEW_BYTES && !forced) return { preview: false, tooLarge: true, pill: false };
  return { preview: true, tooLarge: false, pill: truncated };
}

/** The "Too large to preview · Render anyway" note; clicking the button calls `onRender`. */
export function tooLargeNote(onRender: () => void): HTMLElement {
  const btn = h("button", { class: "md-render-anyway", type: "button" }, "Render anyway");
  btn.addEventListener("click", () => onRender());
  return h("div", { class: "md-notice" }, "Too large to preview · ", btn);
}
