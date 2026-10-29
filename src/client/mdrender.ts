import { resolveRepoPath, safeHref, slugify, type Block, type Inline } from "./markdown.ts";

/** Rendering stops once this many DOM nodes exist. */
const MAX_NODES = 200_000;

class Budget {
  readonly seen = new Map<string, number>();
  constructor(readonly base = "") {}
  n = 0;
  over = false;
  /** Counts `k` nodes; false once the cap is exceeded. */
  take(k = 1): boolean {
    this.n += k;
    if (this.n > MAX_NODES) this.over = true;
    return !this.over;
  }
}

function plainText(nodes: Inline[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text" || n.type === "codespan") out += n.value;
    else if (n.type === "em" || n.type === "strong" || n.type === "del" || n.type === "link") out += plainText(n.children);
    else if (n.type === "image") out += n.alt;
  }
  return out;
}

function link(parent: HTMLElement, n: Extract<Inline, { type: "link" }>, b: Budget) {
  const safe = safeHref(n.href);
  let a: HTMLElement | null = null;
  if (safe) {
    a = document.createElement("a");
    if (safe.kind === "external") {
      a.setAttribute("href", safe.href);
      a.setAttribute("rel", "noopener noreferrer nofollow");
      a.setAttribute("target", "_blank");
    } else if (safe.kind === "fragment") {
      a.setAttribute("href", safe.href);
    } else {
      const r = resolveRepoPath(b.base, safe.href);
      if (r) {
        a.setAttribute("href", "#");
        a.setAttribute("data-md-path", r.path);
        a.setAttribute("data-md-hash", r.hash);
      } else a = null;
    }
  }
  if (a && n.title) a.setAttribute("title", n.title);
  if (a) parent.append(a);
  inline(a ?? parent, n.children, b);
}

function inline(parent: HTMLElement, nodes: Inline[], b: Budget) {
  for (const n of nodes) {
    if (!b.take()) return;
    switch (n.type) {
      case "text":
        parent.append(n.value);
        break;
      case "em":
      case "strong":
      case "del": {
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
        link(parent, n, b);
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
        el.setAttribute("id", "md-" + slugify(plainText(blk.children), b.seen));
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
      case "table": {
        const table = document.createElement("table");
        parent.append(table);
        const thead = document.createElement("thead");
        const tbody = document.createElement("tbody");
        table.append(thead, tbody);
        const row = (host: HTMLElement, cells: Inline[][], tag: "th" | "td") => {
          const tr = document.createElement("tr");
          host.append(tr);
          for (let k = 0; k < cells.length; k++) {
            if (!b.take(2)) return;
            const c = document.createElement(tag);
            const a = blk.align[k];
            if (a) c.className = "md-align-" + a;
            tr.append(c);
            inline(c, cells[k]!, b);
          }
        };
        row(thead, blk.head, "th");
        for (const r of blk.rows) {
          if (b.over || !b.take()) break;
          row(tbody, r, "td");
        }
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
          if (item.checked !== undefined) {
            li.className = "md-task";
            const box = document.createElement("input");
            box.setAttribute("type", "checkbox");
            box.setAttribute("disabled", "");
            if (item.checked) box.setAttribute("checked", "");
            li.append(box);
            b.take();
          }
          blocks(li, item.children, b, blk.tight);
        }
        break;
      }
    }
  }
}

/** Turns the AST into DOM using createElement/textContent only; never innerHTML. */
export function renderMarkdown(list: Block[], opts: { base?: string } = {}): HTMLElement {
  const root = document.createElement("div");
  root.className = "md-doc";
  const b = new Budget(opts.base);
  blocks(root, list, b);
  if (b.over) {
    const note = document.createElement("div");
    note.className = "md-truncated";
    note.textContent = "Preview truncated, view source";
    root.append(note);
  }
  return root;
}
