import type { Block, Inline } from "./markdown.ts";

/** Rendering stops once this many DOM nodes exist. */
const MAX_NODES = 200_000;

class Budget {
  n = 0;
  over = false;
  /** Counts `k` nodes; false once the cap is exceeded. */
  take(k = 1): boolean {
    this.n += k;
    if (this.n > MAX_NODES) this.over = true;
    return !this.over;
  }
}

function inline(parent: HTMLElement, nodes: Inline[], b: Budget) {
  for (const n of nodes) {
    if (!b.take()) return;
    switch (n.type) {
      case "text":
        parent.append(n.value);
        break;
      case "em":
      case "strong": {
        const el = document.createElement(n.type);
        parent.append(el);
        inline(el, n.children, b);
        break;
      }
      case "codespan": {
        const el = document.createElement("code");
        el.textContent = n.value;
        parent.append(el);
        break;
      }
      case "break":
        parent.append(document.createElement("br"));
        break;
      case "link":
        // Links are made clickable (and URL-checked) in a later slice; the label shows as text.
        inline(parent, n.children, b);
        break;
      case "image":
        parent.append(n.alt);
        break;
    }
  }
}

function blocks(parent: HTMLElement, list: Block[], b: Budget, tight = false) {
  for (const blk of list) {
    if (b.over || !b.take()) return;
    switch (blk.type) {
      case "heading": {
        const el = document.createElement(`h${blk.level}`);
        parent.append(el);
        inline(el, blk.children, b);
        break;
      }
      case "paragraph":
        if (tight) {
          inline(parent, blk.children, b);
        } else {
          const el = document.createElement("p");
          parent.append(el);
          inline(el, blk.children, b);
        }
        break;
      case "hr":
        parent.append(document.createElement("hr"));
        break;
      case "code": {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = blk.value;
        pre.append(code);
        parent.append(pre);
        b.take(2);
        break;
      }
      case "blockquote": {
        const el = document.createElement("blockquote");
        parent.append(el);
        blocks(el, blk.children, b);
        break;
      }
      case "list": {
        const el = document.createElement(blk.ordered ? "ol" : "ul");
        if (blk.ordered && blk.start !== 1 && blk.start !== null) el.setAttribute("start", String(blk.start));
        parent.append(el);
        for (const item of blk.items) {
          if (!b.take()) return;
          const li = document.createElement("li");
          el.append(li);
          blocks(li, item.children, b, blk.tight);
        }
        break;
      }
    }
  }
}

/** Turns the AST into DOM using createElement/textContent only; never innerHTML. */
export function renderMarkdown(list: Block[]): HTMLElement {
  const root = document.createElement("div");
  root.className = "md-doc";
  const b = new Budget();
  blocks(root, list, b);
  if (b.over) {
    const note = document.createElement("div");
    note.className = "md-truncated";
    note.textContent = "Preview truncated, view source";
    root.append(note);
  }
  return root;
}
