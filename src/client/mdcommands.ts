import type { Command } from "./palette.ts";

export interface MarkdownHost {
  isMarkdownTab(): boolean;
  toggleMarkdown(): void;
}

/** The "Toggle Markdown Preview" palette command; a no-op unless the active tab is Markdown. */
export function markdownToggleCommand(host: MarkdownHost): Command {
  return {
    id: "view.markdown",
    label: "Toggle Markdown Preview",
    run() {
      if (host.isMarkdownTab()) host.toggleMarkdown();
    },
  };
}
