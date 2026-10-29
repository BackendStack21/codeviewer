// Pure selection model for the code view (0-based line/col in UTF-16 code units). No DOM access.

export interface Pos {
  line: number;
  col: number;
}
export interface SelRange {
  start: Pos;
  end: Pos;
}
export interface PlanPoint {
  line: number;
  offset: number;
}
export interface RestorePlan {
  anchor: PlanPoint;
  focus: PlanPoint;
}

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.col < b.col);

/** Returns a copy of the range with start <= end. */
export function normalize(r: SelRange): SelRange {
  return before(r.end, r.start) ? { start: { ...r.end }, end: { ...r.start } } : { start: { ...r.start }, end: { ...r.end } };
}

/** Exact text covered by the range, lines joined with "\n". */
export function selectionText(lines: readonly string[], r: SelRange): string {
  const { start, end } = normalize(r);
  const out: string[] = [];
  for (let i = start.line; i <= end.line && i < lines.length; i++) {
    const l = lines[i] ?? "";
    out.push(l.slice(i === start.line ? start.col : 0, i === end.line ? end.col : l.length));
  }
  return out.join("\n");
}

/** Range covering the whole file. */
export function allRange(lines: readonly string[]): SelRange {
  const last = Math.max(0, lines.length - 1);
  return { start: { line: 0, col: 0 }, end: { line: last, col: (lines[last] ?? "").length } };
}

/**
 * Maps a model range onto the rendered window [first,last] (line indexes, inclusive).
 * Endpoints outside the window clamp to the window edge (start of first / end of last;
 * `lenOf` gives a line's length). Returns null when the range misses the window.
 */
export function restorePlan(r: SelRange, first: number, last: number, lenOf: (line: number) => number): RestorePlan | null {
  const { start, end } = normalize(r);
  if (end.line < first || start.line > last) return null;
  const anchor = start.line < first ? { line: first, offset: 0 } : { line: start.line, offset: start.col };
  const focus = end.line > last ? { line: last, offset: lenOf(last) } : { line: end.line, offset: end.col };
  return { anchor, focus };
}
