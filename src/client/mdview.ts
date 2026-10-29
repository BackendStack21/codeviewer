import { parseMarkdown } from "./markdown.ts";
import { renderMarkdown } from "./mdrender.ts";

/** Rendered Markdown, mirroring CodeView.setText. `el` is the scroll container. */
export class MarkdownView {
  readonly el: HTMLElement;
  /** Number of times the tree was rebuilt. */
  renders = 0;
  private text = "";

  constructor(text: string, fontSize = 13) {
    this.el = document.createElement("div");
    this.el.className = "md-view";
    this.setFontSize(fontSize);
    this.build(text);
  }

  private build(text: string) {
    this.text = text;
    this.renders++;
    this.el.replaceChildren(renderMarkdown(parseMarkdown(text)));
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
    this.el.replaceChildren();
  }
}
