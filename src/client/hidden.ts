// Hidden-character scanner: zero-width, bidi, tag and variation characters that render as nothing
// (or reorder text) and are used to smuggle content. Pure, no DOM, one linear pass; the server
// imports it too. Results are hints, never verdicts.
export type HiddenKind = "zero-width" | "bidi" | "tag" | "variation";
export interface HiddenHit { line: number; col: number; cp: number; kind: HiddenKind }

const isVariation = (cp: number) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);

/** True when a joiner after `prev` is ordinary (scripts that need it, emoji sequences). */
function joinerExempt(prev: number): boolean {
  return (
    (prev >= 0x0600 && prev <= 0x06ff) ||
    (prev >= 0x0750 && prev <= 0x077f) ||
    (prev >= 0x0900 && prev <= 0x0dff) ||
    prev === 0xfe0f ||
    prev >= 0x1f000
  );
}

/** The kind of a counted character, or undefined. `prev` is the code point just before (-1: none). */
function classify(cp: number, prev: number, offset: number): HiddenKind | undefined {
  if (cp < 0x200b) return undefined;
  if (cp === 0x200b || (cp >= 0x2060 && cp <= 0x2064)) return "zero-width";
  if (cp === 0x200c || cp === 0x200d) return prev >= 0 && joinerExempt(prev) ? undefined : "zero-width";
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return "bidi";
  if (cp === 0xfeff) return offset === 0 ? undefined : "zero-width";
  if (cp >= 0xfe00 && cp <= 0xfe0f) return prev >= 0 && isVariation(prev) ? "variation" : undefined;
  if (cp >= 0xe0000 && cp <= 0xe007f) return "tag";
  if (cp >= 0xe0100 && cp <= 0xe01ef) return "variation";
  return undefined;
}

export function scanHidden(text: string, cap = 200): { count: number; hits: HiddenHit[] } {
  const hits: HiddenHit[] = [];
  let count = 0;
  let line = 1;
  let lineStart = 0;
  let prev = -1;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    if (cp === 0x0a) {
      line++;
      lineStart = i + 1;
    } else {
      const kind = classify(cp, prev, i);
      if (kind) {
        count++;
        if (hits.length < cap) hits.push({ line, col: i - lineStart + 1, cp, kind });
      }
    }
    prev = cp;
    i += width;
  }
  return { count, hits };
}

const hex = (cp: number) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");

export function hiddenName(cp: number): string {
  let name = "";
  if (cp === 0x200b) name = "ZERO WIDTH SPACE";
  else if (cp === 0x200c) name = "ZERO WIDTH NON-JOINER";
  else if (cp === 0x200d) name = "ZERO WIDTH JOINER";
  else if (cp === 0x2060) name = "WORD JOINER";
  else if (cp >= 0x2061 && cp <= 0x2064) name = "INVISIBLE OPERATOR";
  else if (cp === 0xfeff) name = "BYTE ORDER MARK";
  else if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) name = "BIDI CONTROL";
  else if (cp >= 0xe0000 && cp <= 0xe007f) name = "TAG CHARACTER";
  else if (isVariation(cp)) name = "VARIATION SELECTOR";
  return name ? hex(cp) + " " + name : hex(cp);
}

/** The first hit strictly after (line, col) in text order, wrapping to the first; undefined when none. */
export function nextHidden(hits: readonly HiddenHit[], line: number, col: number): HiddenHit | undefined {
  for (const h of hits) if (h.line > line || (h.line === line && h.col > col)) return h;
  return hits[0];
}
