import { hiddenName, nextHidden, scanHidden, type HiddenHit } from "./hidden.ts";

// "Go to Next Hidden Character": walks the scanHidden hits of the active text file. The behaviour
// lives here (not in app.ts) so it can be tested without the app shell.
export interface HiddenNavHost {
  /** The active text file's lines, or null when no text file is shown. */
  lines(): readonly string[] | null;
  /** Reveals a 0-based line. */
  reveal(line: number): void;
  /** Polite live-region announcement. */
  announce(msg: string): void;
  /** Visible toast. */
  toast(msg: string): void;
}

export interface HiddenNav {
  /** Moves to the next hidden character after the remembered position (wrapping) and announces it. */
  next(): void;
  /** Forgets the remembered position (a freshly opened file starts at 0,0). */
  reset(): void;
  /** Notes that the view revealed a 0-based line by other means (search, Go to Line). */
  seen(line: number): void;
}

export function createHiddenNav(host: HiddenNavHost): HiddenNav {
  let line = 0; // 1-based position of the last jump (0: none yet)
  let col = 0;
  let file: readonly string[] | null = null;
  const reset = () => {
    line = 0;
    col = 0;
  };
  return {
    reset,
    seen(l) {
      line = l + 1;
      col = 0;
    },
    next() {
      const lines = host.lines();
      if (file && lines !== file) reset();
      file = lines;
      const hit: HiddenHit | undefined = lines ? nextHidden(scanHidden(lines.join("\n")).hits, line, col) : undefined;
      if (!hit) return void host.toast("No hidden characters in this file");
      line = hit.line;
      col = hit.col;
      host.reveal(hit.line - 1);
      host.announce(`${hiddenName(hit.cp)} at line ${hit.line}, column ${hit.col}`);
    },
  };
}
