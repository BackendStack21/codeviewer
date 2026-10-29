import { api } from "./api.ts";
import { parseMarkdown, slugify } from "./markdown.ts";
import { renderMarkdown } from "./mdrender.ts";

export interface MarkdownViewOptions {
  /** Repo-relative path of the document; relative links resolve against its folder. */
  path?: string;
  /** Fragment (without #) to scroll to once the document is built. */
  hash?: string;
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
  private noticeEl: HTMLElement | null = null;
  /** Bumped on every rebuild and dispose; late image loads from an older epoch are dropped. */
  private epoch = 0;
  private blobs: string[] = [];

  constructor(text: string, fontSize = 13, private opts: MarkdownViewOptions = {}) {
    this.el = document.createElement("div");
    this.el.className = "md-view";
    this.setFontSize(fontSize);
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.addEventListener("contextmenu", (e) => {
      if (this.selectionRange()) this.onContextMenu(e);
    });
    this.build(text);
    if (opts.hash) this.scrollToFragment(opts.hash);
  }

  /** Set by the app: shows the Copy / Copy as Image menu (only called when a selection exists). */
  onContextMenu: (e: MouseEvent) => void = () => {};

  private onClick(e: MouseEvent) {
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a || !this.el.contains(a)) return;
    const path = a.getAttribute("data-md-path");
    const href = a.getAttribute("href") ?? "";
    if (path !== null) {
      e.preventDefault();
      const done = (ok: boolean | void) => {
        if (ok === false) this.notice("File not found");
        else this.clearNotice();
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
      this.clearNotice();
      this.scrollToFragment(href.slice(1));
    }
  }

  /** Scrolls to the heading a fragment names (slugified like GitHub); false when there is none. */
  scrollToFragment(frag: string): boolean {
    let f = frag;
    try {
      f = decodeURIComponent(f);
    } catch {
      // use as written
    }
    if (!f) return false;
    const id = "md-" + slugify(f);
    for (const hd of Array.from(this.el.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
      if (hd.getAttribute("id") === id) {
        hd.scrollIntoView({ block: "start" });
        return true;
      }
    }
    return false;
  }

  private notice(msg: string) {
    const n = document.createElement("div");
    n.className = "md-notice";
    n.textContent = msg;
    this.noticeEl = n;
    if (this.root) this.el.replaceChildren(n, this.root);
  }

  private clearNotice() {
    if (!this.noticeEl) return;
    this.noticeEl = null;
    if (this.root) this.el.replaceChildren(this.root);
  }

  private revokeAll() {
    this.epoch++;
    for (const u of this.blobs) URL.revokeObjectURL(u);
    this.blobs = [];
  }

  private loadImage(img: HTMLElement, path: string, alt: string, wrap: HTMLElement, epoch: number) {
    api.rawBlobUrl(path).then(
      (url) => {
        if (epoch !== this.epoch) return void URL.revokeObjectURL(url);
        this.blobs.push(url);
        img.setAttribute("src", url);
      },
      () => {
        if (epoch === this.epoch) wrap.replaceChildren(alt);
      },
    );
  }

  private build(text: string) {
    this.revokeAll();
    const epoch = this.epoch;
    this.text = text;
    this.renders++;
    this.noticeEl = null;
    const dir = this.opts.path ? this.opts.path.slice(0, Math.max(0, this.opts.path.lastIndexOf("/"))) : "";
    this.root = renderMarkdown(parseMarkdown(text), {
      base: dir,
      onImage: (img, path, alt, wrap) => this.loadImage(img, path, alt, wrap, epoch),
    });
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

  /** The live selection range when it lies inside this view, else null. */
  selectionRange(): Range | null {
    const sel = window.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    return this.el.contains(r.commonAncestorContainer) ? r : null;
  }

  setFontSize(px: number) {
    this.el.style.fontSize = `${px}px`;
  }

  dispose() {
    this.revokeAll();
    this.text = "";
    this.root = null;
    this.noticeEl = null;
    this.el.replaceChildren();
  }
}
