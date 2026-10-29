import { parseMarkdown } from "./markdown.ts";
import { renderMarkdown } from "./mdrender.ts";

export interface MarkdownViewOptions {
  /** Repo-relative path of the document; relative links resolve against its folder. */
  path?: string;
  /** Opens a resolved repo path; resolve/return false when the target does not exist. */
  onOpen?: (path: string, hash: string) => boolean | void | Promise<boolean | void>;
}

/** Rendered Markdown, mirroring CodeView.setText. `el` is the scroll container. */
export class MarkdownView {
  readonly el: HTMLElement;
  /** Number of times the tree was rebuilt. */
  renders = 0;
  private text = "";
  private root: HTMLElement | null = null;

  constructor(text: string, fontSize = 13, private opts: MarkdownViewOptions = {}) {
    this.el = document.createElement("div");
    this.el.className = "md-view";
    this.setFontSize(fontSize);
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.build(text);
  }

  private onClick(e: MouseEvent) {
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a || !this.el.contains(a)) return;
    const path = a.getAttribute("data-md-path");
    const href = a.getAttribute("href") ?? "";
    if (path !== null) {
      e.preventDefault();
      const done = (ok: boolean | void) => {
        if (ok === false) this.notice("File not found");
      };
      try {
        const r = this.opts.onOpen?.(path, a.getAttribute("data-md-hash") ?? "");
        if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<boolean | void>).then(done, () => done(false));
        else done(r as boolean | void);
      } catch {
        done(false);
      }
    } else if (href.startsWith("#")) {
      e.preventDefault();
      let frag = href.slice(1);
      try {
        frag = decodeURIComponent(frag);
      } catch {
        // use as written
      }
      const id = "md-" + frag.toLowerCase();
      for (const hd of Array.from(this.el.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
        if (hd.getAttribute("id") === id) {
          hd.scrollIntoView({ block: "start" });
          break;
        }
      }
    }
  }

  private notice(msg: string) {
    const n = document.createElement("div");
    n.className = "md-notice";
    n.textContent = msg;
    if (this.root) this.el.replaceChildren(n, this.root);
  }

  private build(text: string) {
    this.text = text;
    this.renders++;
    const dir = this.opts.path ? this.opts.path.slice(0, Math.max(0, this.opts.path.lastIndexOf("/"))) : "";
    this.root = renderMarkdown(parseMarkdown(text), { base: dir });
    this.el.replaceChildren(this.root);
  }

  /** Re-renders unless the text is identical; keeps scrollTop. Returns true when the tree was rebuilt. */
  setText(text: string): boolean {
    if (text === this.text) return false;
    const top = this.el.scrollTop;
    this.build(text);
    this.el.scrollTop = top;
    return true;
  }

  setFontSize(px: number) {
    this.el.style.fontSize = `${px}px`;
  }

  dispose() {
    this.text = "";
    this.root = null;
    this.el.replaceChildren();
  }
}
