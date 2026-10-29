import { isMarkdown } from "./markdown.ts";

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
