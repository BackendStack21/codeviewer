import { isMarkdown } from "./markdown.ts";
import { decidePreview } from "./mdgate.ts";

// Pure per-load view decision for a tab, so the editor's branching is testable without a DOM.

export type LoadKind = "text" | "image" | "binary" | "error" | "dir";
export type ViewName = "md" | "code" | "image" | "binary" | "dir" | "error";

export interface ViewInput {
  kind: LoadKind;
  path: string;
  asSource: boolean;
  /** A live reload of an already open tab (not the first load or a mode switch). */
  reload: boolean;
  hasMd: boolean;
  hasCode: boolean;
}

export interface ViewPlan {
  view: ViewName;
  /** Update the existing view in place instead of building a new one. */
  reuse: boolean;
  /** Whether the tab keeps a MarkdownView after this load (otherwise dispose and clear it). */
  md: boolean;
  /** Whether the tab keeps a CodeView after this load (otherwise clear it). */
  code: boolean;
}

export function planView(i: ViewInput): ViewPlan {
  if (i.kind !== "text") return { view: i.kind, reuse: false, md: false, code: false };
  if (isMarkdown(i.path) && !i.asSource) return { view: "md", reuse: i.reload && i.hasMd, md: true, code: false };
  return { view: "code", reuse: i.reload && i.hasCode, md: false, code: true };
}

/** Per-tab Markdown mode: the user's choice and whether they asked to preview a file over the size cap. */
export interface ModeState {
  asSource: boolean;
  forcePreview: boolean;
}

/** What a load of a text file shows: the preview only for Markdown, not chosen as source and not gated by size. */
export function viewMode(path: string, size: number, truncated: boolean, s: ModeState): "source" | "preview" {
  if (!isMarkdown(path) || s.asSource) return "source";
  return decidePreview(size, truncated, s.forcePreview).preview ? "preview" : "source";
}

/** The state after the toggle is used: from a shown source to the (forced) preview, and back. */
export function toggleMode(path: string, size: number, truncated: boolean, s: ModeState): ModeState {
  return viewMode(path, size, truncated, s) === "source"
    ? { asSource: false, forcePreview: true }
    : { asSource: true, forcePreview: s.forcePreview };
}

export const toggleLabel = (mode: "source" | "preview") => (mode === "source" ? "Preview" : "View source");
