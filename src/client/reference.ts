// Copy Reference: `path:12` / `path:12-40`, the form agents, `codeviewer open` and terminal ⌘-click
// all read, optionally followed by the lines as a fenced code block. Pure, no DOM.

import type { SelRange } from "./selection.ts";

/** 1-based inclusive line span. */
export interface Span {
  from: number;
  to: number;
}

/**
 * The lines a selection covers (1-based), or the active line without one. A selection that ends
 * at column 0 of a later line (a drag to the start of the next line, or whole-line selects) does
 * not include that line.
 */
export function lineSpan(sel: SelRange | null, activeLine: number): Span | null {
  if (sel && (sel.start.line !== sel.end.line || sel.start.col !== sel.end.col)) {
    const end = sel.end.col === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    return { from: sel.start.line + 1, to: end + 1 };
  }
  return activeLine >= 0 ? { from: activeLine + 1, to: activeLine + 1 } : null;
}

/**
 * True when a path holds control or bidi characters (repository file names are untrusted): such
 * a reference is refused, since pasted at a prompt without bracketed paste a newline would run
 * what follows it.
 */
export function unsafePath(path: string): boolean {
  return /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(path);
}

export function reference(path: string, span: Span | null): string {
  if (!span) return path;
  return span.to > span.from ? `${path}:${span.from}-${span.to}` : `${path}:${span.from}`;
}

/** The reference, then the spanned lines in a fence longer than any backtick run inside them. */
export function referenceWithCode(path: string, span: Span, lines: readonly string[]): string {
  const body = lines.slice(span.from - 1, span.to).join("\n");
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const info = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^\w+-]/g, "") : "";
  return `${reference(path, span)}\n${fence}${info}\n${body}\n${fence}\n`;
}

/** Splits `path`, `path:12`, `path:12:5` or `path:12-40` into the path and its first line (0 = none). */
export function parseTarget(t: string): { path: string; line: number } {
  const m = /^(.*?)(?::(\d+)(?:-\d+)?)?(?::\d+)?$/.exec(t)!;
  return { path: m[1]!, line: Number(m[2] ?? 0) };
}
