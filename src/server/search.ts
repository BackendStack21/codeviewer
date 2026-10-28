// Project-wide content search: pure matcher (compileQuery, matchText).

export interface SearchMatch {
  line: number;
  col: number;
  len: number;
  preview: string;
  pcol: number;
}

export interface SearchOptions {
  regex?: boolean;
  case?: boolean;
  word?: boolean;
}

export type CompiledQuery = { ok: true; re: RegExp } | { ok: false; error: string };

export interface MatchResult {
  matches: SearchMatch[];
  more: number;
}

const MAX_QUERY = 256;
const PREVIEW_LEN = 200;
const PREVIEW_LEAD = 30;

export function compileQuery(q: string, o: SearchOptions = {}): CompiledQuery {
  if (!q) return { ok: false, error: "Empty query" };
  if (q.length > MAX_QUERY) return { ok: false, error: "Query too long" };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(q)) return { ok: false, error: "Invalid characters in query" };
  let src = o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (o.word) src = `\\b(?:${src})\\b`;
  try {
    return { ok: true, re: new RegExp(src, o.case ? "gu" : "giu") };
  } catch {
    return { ok: false, error: "Invalid regular expression" };
  }
}

export function matchText(text: string, re: RegExp, maxPerFile = 100): MatchResult {
  const matches: SearchMatch[] = [];
  let more = 0;
  // Line starts, split on \r\n | \r | \n like the client.
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    } else if (c === 10) starts.push(i + 1);
  }
  const lineEnd = (n: number): number => {
    let e = n + 1 < starts.length ? starts[n + 1]! : text.length + 1;
    e--; // drop the terminator's last char
    if (n + 1 < starts.length && text.charCodeAt(e - 1) === 13 && text.charCodeAt(e) === 10) e--;
    return e;
  };
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= m.index) lo = mid;
      else hi = mid - 1;
    }
    const ls = starts[lo]!;
    const col = m.index - ls;
    const len = Math.min(m[0].length, lineEnd(lo) - m.index);
    if (len <= 0) continue;
    if (matches.length >= maxPerFile) {
      more++;
      continue;
    }
    const line = text.slice(ls, lineEnd(lo));
    let start = col > PREVIEW_LEAD ? col - PREVIEW_LEAD : 0;
    const lowSurrogate = (i: number) => (line.charCodeAt(i) & 0xfc00) === 0xdc00;
    if (start > 0 && lowSurrogate(start)) start++;
    const lead = start > 0 ? "…" : "";
    matches.push({
      line: lo + 1,
      col,
      len,
      preview: lead + line.slice(start, start + PREVIEW_LEN),
      pcol: lead.length + col - start,
    });
  }
  return { matches, more };
}
