import type { Block, Inline } from "./markdown.ts";

function inline(parent: HTMLElement, nodes: Inline[]) {
  for (const n of nodes) parent.append(n.value);
}

/** Turns the AST into DOM using createElement/textContent only; never innerHTML. */
export function renderMarkdown(blocks: Block[]): HTMLElement {
  const root = document.createElement("div");
  root.className = "md-doc";
  for (const b of blocks) {
    const el = document.createElement(b.type === "heading" ? `h${b.level}` : "p");
    inline(el, b.children);
    root.append(el);
  }
  return root;
}
