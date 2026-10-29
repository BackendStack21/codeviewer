// Pure Markdown parser: no DOM, no dependencies, linear time. The block pass is line-oriented with
// nesting capped at 32 (so recursion is bounded); the inline pass uses a CommonMark-style delimiter
// stack. Every limit degrades to literal text and nothing here throws on any input.

export interface Text {
  type: "text";
  value: string;
}
export interface Emphasis {
  type: "em" | "strong";
  children: Inline[];
}
export interface CodeSpan {
  type: "codespan";
  value: string;
}
export interface Break {
  type: "break";
}
export interface Link {
  type: "link";
  href: string;
  title: string | null;
  children: Inline[];
}
export interface Image {
  type: "image";
  src: string;
  alt: string;
  title: string | null;
}
export type Inline = Text | Emphasis | CodeSpan | Break | Link | Image;
export interface Heading {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: Inline[];
}
export interface Paragraph {
  type: "paragraph";
  children: Inline[];
}
export interface ThematicBreak {
  type: "hr";
}
/** Fenced (lang = first word of the info string) or indented (lang = null) code. */
export interface CodeBlock {
  type: "code";
  lang: string | null;
  value: string;
}
export interface BlockQuote {
  type: "blockquote";
  children: Block[];
}
export interface ListItem {
  type: "item";
  children: Block[];
}
export interface List {
  type: "list";
  ordered: boolean;
  /** Start number of an ordered list; null for bullet lists. */
  start: number | null;
  tight: boolean;
  items: ListItem[];
}
export type Block = Heading | Paragraph | ThematicBreak | CodeBlock | BlockQuote | List;

/** True for `.md` / `.markdown` paths, case-insensitive. */
export function isMarkdown(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return name.endsWith(".md") || name.endsWith(".markdown");
}


const MAX_DEPTH = 32; // container nesting and inline nesting
const MAX_LINE = 10_000; // inline characters per line before the text is left literal
const MAX_DEFS = 10_000; // link reference definitions
const MAX_SCAN = 1500; // characters scanned for a link destination/title
const MAX_LABEL = 999;

const isWs = (c: string | undefined) => c === " " || c === "\t";

function expandTabs(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  if (!line.slice(0, i).includes("\t")) return line;
  let col = 0;
  for (let k = 0; k < i; k++) col = line[k] === "\t" ? col + 4 - (col % 4) : col + 1;
  return " ".repeat(col) + line.slice(i);
}
function indent(line: string): number {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  return i;
}
function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** ATX heading: up to 3 spaces, 1-6 `#`, then whitespace or end of line. */
function atx(line: string): { level: Heading["level"]; text: string } | null {
  const i = indent(line);
  if (i > 3) return null;
  let n = 0;
  while (line[i + n] === "#") n++;
  if (n < 1 || n > 6) return null;
  const rest = line[i + n];
  if (rest !== undefined && !isWs(rest)) return null;
  let text = line.slice(i + n).trim();
  // Optional closing sequence of `#`, preceded by whitespace (or the whole content).
  let e = text.length;
  while (e > 0 && text[e - 1] === "#") e--;
  if (e < text.length && (e === 0 || isWs(text[e - 1]))) text = text.slice(0, e).trim();
  return { level: n as Heading["level"], text };
}

/** Thematic break: 3+ of `-`, `_` or `*` (spaces allowed between), indent <= 3. */
function isHr(line: string): boolean {
  const i = indent(line);
  if (i > 3) return false;
  const ch = line[i];
  if (ch !== "-" && ch !== "_" && ch !== "*") return false;
  let n = 0;
  for (let k = i; k < line.length; k++) {
    const c = line[k];
    if (c === ch) n++;
    else if (c !== " " && c !== "\t") return false;
  }
  return n >= 3;
}

/** Setext underline: `=` run (level 1) or `-` run (level 2), trailing spaces only. */
function setext(line: string): 1 | 2 | null {
  const i = indent(line);
  if (i > 3) return null;
  const ch = line[i];
  if (ch !== "=" && ch !== "-") return null;
  let k = i;
  while (line[k] === ch) k++;
  while (k < line.length && isWs(line[k])) k++;
  return k === line.length ? (ch === "=" ? 1 : 2) : null;
}

interface Fence {
  ch: string;
  len: number;
  indent: number;
  lang: string | null;
}
function fenceOpen(line: string): Fence | null {
  const i = indent(line);
  if (i > 3) return null;
  const ch = line[i];
  if (ch !== "`" && ch !== "~") return null;
  let n = 0;
  while (line[i + n] === ch) n++;
  if (n < 3) return null;
  const info = line.slice(i + n).trim();
  if (ch === "`" && info.includes("`")) return null;
  const word = info.split(/[ \t]/, 1)[0] ?? "";
  return { ch, len: n, indent: i, lang: word ? unescapeStr(word) : null };
}
function fenceClose(line: string, f: Fence): boolean {
  const i = indent(line);
  if (i > 3) return false;
  let n = 0;
  while (line[i + n] === f.ch) n++;
  return n >= f.len && isBlank(line.slice(i + n));
}

/** Position just after a `>` marker (and one optional space), or -1. */
function quoteAt(line: string): number {
  const i = indent(line);
  if (i > 3 || line[i] !== ">") return -1;
  return line[i + 1] === " " ? i + 2 : i + 1;
}

interface Marker {
  key: string;
  ordered: boolean;
  num: number;
  offset: number;
  empty: boolean;
}
function listMarker(line: string): Marker | null {
  const i = indent(line);
  if (i > 3) return null;
  const c = line[i];
  let end: number;
  let key: string;
  let ordered = false;
  let num = 0;
  if (c === "-" || c === "+" || c === "*") {
    end = i + 1;
    key = "b" + c;
  } else if (c !== undefined && c >= "0" && c <= "9") {
    let k = i;
    while (k < line.length && k - i < 10 && line[k]! >= "0" && line[k]! <= "9") k++;
    if (k - i > 9) return null;
    const d = line[k];
    if (d !== "." && d !== ")") return null;
    ordered = true;
    num = Number(line.slice(i, k));
    end = k + 1;
    key = "o" + d;
  } else return null;
  if (end < line.length && !isWs(line[end])) return null;
  let sp = 0;
  while (isWs(line[end + sp])) sp++;
  const empty = end + sp >= line.length;
  const offset = empty || sp >= 5 ? end + 1 : end + sp;
  return { key, ordered, num, offset, empty };
}

/** Would this line start a block that interrupts an open paragraph (or ends a lazy continuation)? */
function startsBlock(line: string, container: boolean): boolean {
  if (indent(line) > 3) return false;
  if (isHr(line) || atx(line) || fenceOpen(line)) return true;
  if (!container) return false;
  if (quoteAt(line) >= 0) return true;
  const m = listMarker(line);
  return !!m && !m.empty && (!m.ordered || m.num === 1);
}

/** Is a paragraph still open after this line (for lazy continuation)? */
function paraOpen(line: string): boolean {
  let s = line;
  for (let n = 0; n < MAX_DEPTH + 1; n++) {
    const q = quoteAt(s);
    if (q >= 0) {
      s = s.slice(q);
      continue;
    }
    const m = listMarker(s);
    if (m && !m.empty && !isHr(s)) {
      s = s.slice(m.offset);
      continue;
    }
    break;
  }
  return !isBlank(s) && !isHr(s) && !atx(s) && !fenceOpen(s) && indent(s) < 4;
}

// ---------------------------------------------------------------------------------------------
// Entities, escapes

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const PUNCT = /[!-/:-@[-`{-~]/;

function decodeEntity(s: string, i: number): { str: string; len: number } | null {
  const end = s.indexOf(";", i + 2);
  if (end < 0 || end - i > 12) return null;
  const body = s.slice(i + 1, end);
  let str: string | undefined;
  if (body[0] === "#") {
    const hex = body[1] === "x" || body[1] === "X";
    const digits = body.slice(hex ? 2 : 1);
    if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) return null;
    const cp = parseInt(digits, hex ? 16 : 10);
    str = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "�" : String.fromCodePoint(cp);
  } else if (Object.hasOwn(ENTITIES, body)) str = ENTITIES[body];
  return str === undefined ? null : { str, len: end + 1 - i };
}

/** Resolve backslash escapes and entities in a link destination, title or info string. */
function unescapeStr(s: string): string {
  if (!s.includes("\\") && !s.includes("&")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1]!)) out += s[++i];
    else if (c === "&") {
      const e = decodeEntity(s, i);
      if (e) {
        out += e.str;
        i += e.len - 1;
      } else out += c;
    } else out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Link reference definitions

type Defs = Map<string, { href: string; title: string | null }>;
const normLabel = (l: string) => l.trim().replace(/\s+/g, " ").toLowerCase();

function parseDef(line: string): { label: string; href: string; title: string | null } | null {
  let i = indent(line);
  if (i > 3 || line[i] !== "[") return null;
  let j = i + 1;
  while (j < line.length && j - i <= MAX_LABEL && line[j] !== "]") {
    if (line[j] === "[") return null;
    if (line[j] === "\\") j++;
    j++;
  }
  if (line[j] !== "]" || line[j + 1] !== ":") return null;
  const label = line.slice(i + 1, j);
  if (isBlank(label)) return null;
  let k = j + 2;
  while (isWs(line[k])) k++;
  let href: string;
  if (line[k] === "<") {
    const e = line.indexOf(">", k + 1);
    if (e < 0) return null;
    href = line.slice(k + 1, e);
    k = e + 1;
  } else {
    const st = k;
    while (k < line.length && !isWs(line[k])) k++;
    href = line.slice(st, k);
    if (!href) return null;
  }
  const afterDest = k;
  while (isWs(line[k])) k++;
  if (k >= line.length) return { label, href: unescapeStr(href), title: null };
  if (k === afterDest) return null;
  const open = line[k]!;
  const close = open === "(" ? ")" : open;
  if (open !== '"' && open !== "'" && open !== "(") return null;
  const rest = line.slice(k).trimEnd();
  if (rest.length < 2 || rest[rest.length - 1] !== close) return null;
  return { label, href: unescapeStr(href), title: unescapeStr(rest.slice(1, -1)) };
}

// ---------------------------------------------------------------------------------------------
// Block pass

interface Pending {
  node: Heading | Paragraph;
  text: string;
}
interface Ctx {
  defs: Defs;
  pending: Pending[];
}

interface FenceTrack {
  f: Fence | null;
}
function track(t: FenceTrack, line: string) {
  if (t.f) {
    if (fenceClose(line, t.f)) t.f = null;
  } else t.f = fenceOpen(line);
}

function parseBlocks(lines: string[], depth: number, ctx: Ctx): { blocks: Block[]; gap: boolean } {
  const blocks: Block[] = [];
  const n = lines.length;
  const canNest = depth < MAX_DEPTH;
  let gap = false;
  let blank = false;
  let para: string[] = [];
  let paraBlank = false;

  const add = (b: Block) => {
    if (blank && blocks.length) gap = true;
    blank = false;
    blocks.push(b);
  };
  const addText = (b: Heading | Paragraph, text: string) => {
    ctx.pending.push({ node: b, text });
    blocks.push(b);
  };
  const flush = () => {
    if (!para.length) return;
    let from = 0;
    while (from < para.length && ctx.defs.size < MAX_DEFS) {
      const d = parseDef(para[from]!);
      if (!d) break;
      const key = normLabel(d.label);
      if (!ctx.defs.has(key)) ctx.defs.set(key, { href: d.href, title: d.title });
      from++;
    }
    const rest = from ? para.slice(from) : para;
    para = [];
    if (!rest.length) {
      if (paraBlank && blocks.length) gap = true;
      return;
    }
    if (paraBlank && blocks.length) gap = true;
    addText({ type: "paragraph", children: [] }, rest.join("\n").trimEnd());
  };

  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (isBlank(line)) {
      flush();
      blank = true;
      i++;
      continue;
    }
    if (para.length) {
      const su = setext(line);
      if (su) {
        if (paraBlank && blocks.length) gap = true;
        addText({ type: "heading", level: su, children: [] }, para.map((l) => l.trim()).join("\n"));
        para = [];
        i++;
        continue;
      }
      if (!startsBlock(line, canNest)) {
        para.push(line.trimStart());
        i++;
        continue;
      }
      flush();
    }
    const ind = indent(line);
    if (ind >= 4) {
      const code: string[] = [];
      let last = i;
      let j = i;
      while (j < n && (isBlank(lines[j]!) || indent(lines[j]!) >= 4)) {
        code.push(lines[j]!.slice(4));
        if (!isBlank(lines[j]!)) last = j;
        j++;
      }
      code.length = last - i + 1;
      add({ type: "code", lang: null, value: code.join("\n") });
      i = last + 1;
      continue;
    }
    const f = fenceOpen(line);
    if (f) {
      const body: string[] = [];
      let j = i + 1;
      while (j < n && !fenceClose(lines[j]!, f)) {
        const l = lines[j]!;
        let strip = 0;
        while (strip < f.indent && l[strip] === " ") strip++;
        body.push(l.slice(strip));
        j++;
      }
      add({ type: "code", lang: f.lang, value: body.join("\n") });
      i = j + 1;
      continue;
    }
    const h = atx(line);
    if (h) {
      if (blank && blocks.length) gap = true;
      blank = false;
      addText({ type: "heading", level: h.level, children: [] }, h.text);
      i++;
      continue;
    }
    if (isHr(line)) {
      add({ type: "hr" });
      i++;
      continue;
    }
    if (canNest && quoteAt(line) >= 0) {
      const inner: string[] = [];
      const t: FenceTrack = { f: null };
      while (i < n) {
        const L = lines[i]!;
        const q = quoteAt(L);
        if (q >= 0) {
          const s = L.slice(q);
          inner.push(s);
          track(t, s);
        } else if (!isBlank(L) && inner.length && !t.f && paraOpen(inner[inner.length - 1]!) && !startsBlock(L, true) && !listMarker(L)) inner.push(L);
        else break;
        i++;
      }
      add({ type: "blockquote", children: parseBlocks(inner, depth + 1, ctx).blocks });
      continue;
    }
    const m = canNest ? listMarker(line) : null;
    if (m) {
      const items: ListItem[] = [];
      let loose = false;
      while (i < n) {
        const cur = listMarker(lines[i]!);
        if (!cur || cur.key !== m.key || isHr(lines[i]!)) break;
        const itemLines = [lines[i]!.slice(cur.offset)];
        const t: FenceTrack = { f: null };
        track(t, itemLines[0]!);
        i++;
        let blanks = 0;
        if (!(cur.empty && i < n && isBlank(lines[i]!))) {
          while (i < n) {
            const L = lines[i]!;
            if (isBlank(L)) {
              blanks++;
              i++;
              continue;
            }
            if (indent(L) >= cur.offset) {
              for (; blanks > 0; blanks--) itemLines.push("");
              const s = L.slice(cur.offset);
              itemLines.push(s);
              track(t, s);
            } else if (blanks === 0 && !t.f && paraOpen(itemLines[itemLines.length - 1]!) && !startsBlock(L, true) && !listMarker(L)) itemLines.push(L);
            else break;
            i++;
          }
        }
        const r = parseBlocks(itemLines, depth + 1, ctx);
        if (r.gap) loose = true;
        items.push({ type: "item", children: r.blocks });
        const nxt = i < n ? listMarker(lines[i]!) : null;
        if (nxt && nxt.key === m.key && !isHr(lines[i]!)) {
          if (blanks > 0) loose = true;
        } else {
          i -= blanks;
          break;
        }
      }
      add({ type: "list", ordered: m.ordered, start: m.ordered ? m.num : null, tight: !loose, items });
      continue;
    }
    paraBlank = blank;
    blank = false;
    para.push(line.trimStart());
    i++;
  }
  flush();
  return { blocks, gap };
}

// ---------------------------------------------------------------------------------------------
// Inline pass

interface N {
  k: 0 | 1 | 2; // text | finished node | delimiter run
  v: string;
  node?: Inline;
  d: number; // nesting depth of a finished node
  prev: N | null;
  next: N | null;
  ch: string;
  n: number; // remaining delimiter characters
  orig: number;
  open: boolean;
  close: boolean;
  dprev: N | null;
  dnext: N | null;
}
const mk = (k: 0 | 1 | 2, v = ""): N => ({ k, v, d: 0, prev: null, next: null, ch: "", n: 0, orig: 0, open: false, close: false, dprev: null, dnext: null });

interface Bracket {
  n: N;
  img: boolean;
  src: number; // index just after the `[`
  dBottom: N | null;
  serial: number;
}

const WS = /\s/;
const UPUNCT = /[\p{P}\p{S}]/u;

function toInline(nodes: N[]): Inline[] {
  const out: Inline[] = [];
  const text = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.type === "text") last.value += s;
    else out.push({ type: "text", value: s });
  };
  for (const x of nodes) {
    if (x.k === 0) text(x.v);
    else if (x.k === 2) text(x.ch.repeat(x.n));
    else if (x.node!.type === "text") text((x.node as Text).value);
    else out.push(x.node!);
  }
  return out;
}
function plain(nodes: Inline[]): string {
  let s = "";
  for (const x of nodes) {
    if (x.type === "text" || x.type === "codespan") s += x.value;
    else if (x.type === "image") s += x.alt;
    else if (x.type === "break") s += " ";
    else s += plain(x.children);
  }
  return s;
}

/** Destination and optional title of an inline link, starting just after the `(`. */
function linkTail(s: string, p: number): { href: string; title: string | null; end: number } | null {
  const lim = Math.min(s.length, p + MAX_SCAN);
  let k = p;
  const skip = () => {
    while (k < lim && (s[k] === " " || s[k] === "\n" || s[k] === "\t")) k++;
  };
  skip();
  let href: string;
  if (s[k] === "<") {
    let e = k + 1;
    while (e < lim && s[e] !== ">" && s[e] !== "\n" && s[e] !== "<") e++;
    if (s[e] !== ">") return null;
    href = unescapeStr(s.slice(k + 1, e));
    k = e + 1;
  } else {
    const st = k;
    let depth = 0;
    while (k < lim) {
      const c = s[k]!;
      if (c === "\\" && k + 1 < lim && PUNCT.test(s[k + 1]!)) {
        k += 2;
        continue;
      }
      if (c <= " " || c === "\x7f") break;
      if (c === "(") {
        if (++depth > MAX_DEPTH) return null;
      } else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    if (depth !== 0) return null;
    href = unescapeStr(s.slice(st, k));
  }
  const before = k;
  skip();
  let title: string | null = null;
  const o = s[k];
  if (k > before && (o === '"' || o === "'" || o === "(")) {
    const close = o === "(" ? ")" : o;
    let e = k + 1;
    while (e < lim && s[e] !== close) e += s[e] === "\\" ? 2 : 1;
    if (e >= lim || s[e] !== close) return null;
    title = unescapeStr(s.slice(k + 1, e));
    k = e + 1;
    skip();
  }
  if (s[k] !== ")") return null;
  return { href, title, end: k + 1 };
}

/** End index of a `[label]` starting at p (just after the `[`), or -1. */
function labelEnd(s: string, p: number): number {
  const lim = Math.min(s.length, p + MAX_LABEL + 1);
  for (let k = p; k < lim; k++) {
    const c = s[k];
    if (c === "\\") k++;
    else if (c === "[") return -1;
    else if (c === "]") return k;
  }
  return -1;
}

function parseInline(s: string, defs: Defs): Inline[] {
  let head: N | null = null;
  let tail: N | null = null;
  let dhead: N | null = null;
  let dtail: N | null = null;
  const brackets: Bracket[] = [];
  let serial = 0;
  let linkSerial = 0;

  const append = (x: N) => {
    x.prev = tail;
    x.next = null;
    if (tail) tail.next = x;
    else head = x;
    tail = x;
  };
  const unlink = (x: N) => {
    if (x.prev) x.prev.next = x.next;
    else head = x.next;
    if (x.next) x.next.prev = x.prev;
    else tail = x.prev;
  };
  const dunlink = (x: N) => {
    if (x.dprev) x.dprev.dnext = x.dnext;
    else dhead = x.dnext;
    if (x.dnext) x.dnext.dprev = x.dprev;
    else dtail = x.dprev;
  };
  const text = (v: string) => {
    if (v) {
      const x = mk(0, v);
      append(x);
    }
  };
  const nodeOf = (node: Inline, d: number) => {
    const x = mk(1);
    x.node = node;
    x.d = d;
    return x;
  };
  const range = (after: N | null): N[] => {
    const out: N[] = [];
    for (let x = after ? after.next : head; x; x = x.next) out.push(x);
    return out;
  };
  const depthOf = (kids: N[]) => {
    let d = 0;
    for (const x of kids) if (x.k === 1 && x.d > d) d = x.d;
    return d;
  };

  function processEmph(bottom: N | null) {
    const ob = new Map<string, N | null>();
    let closer = bottom ? bottom.dnext : dhead;
    while (closer) {
      if (!closer.close) {
        closer = closer.dnext;
        continue;
      }
      const key = closer.ch + (closer.orig % 3) + (closer.open ? 1 : 0);
      const lim = ob.has(key) ? ob.get(key)! : bottom;
      let opener = closer.dprev;
      let found: N | null = null;
      while (opener && opener !== bottom && opener !== lim) {
        if (opener.ch === closer.ch && opener.open) {
          const odd = (closer.open || opener.close) && closer.orig % 3 !== 0 && (opener.orig + closer.orig) % 3 === 0;
          if (!odd) {
            found = opener;
            break;
          }
        }
        opener = opener.dprev;
      }
      if (found) {
        const kids: N[] = [];
        for (let x = found.next!; x !== closer; x = x.next!) kids.push(x);
        const d = depthOf(kids);
        if (d + 1 > MAX_DEPTH) found = null;
        else {
          const use = closer.n >= 2 && found.n >= 2 ? 2 : 1;
          const en = nodeOf({ type: use === 2 ? "strong" : "em", children: toInline(kids) }, d + 1);
          found.next = en;
          en.prev = found;
          en.next = closer;
          closer.prev = en;
          found.dnext = closer;
          closer.dprev = found;
          found.n -= use;
          closer.n -= use;
          if (found.n === 0) {
            unlink(found);
            dunlink(found);
          }
          if (closer.n === 0) {
            const nx = closer.dnext;
            unlink(closer);
            dunlink(closer);
            closer = nx;
          }
          continue;
        }
      }
      const old: N = closer;
      closer = closer.dnext;
      ob.set(key, old.dprev);
      if (!old.open) dunlink(old);
    }
    if (bottom) {
      bottom.dnext = null;
      dtail = bottom;
    } else {
      dhead = null;
      dtail = null;
    }
  }

  // Backtick runs, indexed lazily by length with a monotonic pointer per length.
  let runs: Map<number, { pos: number[]; ptr: number }> | null = null;
  const closingRun = (len: number, from: number): number => {
    if (!runs) {
      runs = new Map();
      for (let k = 0; k < s.length; ) {
        if (s.charCodeAt(k) !== 96) {
          k++;
          continue;
        }
        let e = k;
        while (s.charCodeAt(e) === 96) e++;
        let r = runs.get(e - k);
        if (!r) runs.set(e - k, (r = { pos: [], ptr: 0 }));
        r.pos.push(k);
        k = e;
      }
    }
    const r = runs.get(len);
    if (!r) return -1;
    while (r.ptr < r.pos.length && r.pos[r.ptr]! < from) r.ptr++;
    return r.ptr < r.pos.length ? r.pos[r.ptr]! : -1;
  };

  let run = 0;
  let i = 0;
  const len = s.length;
  const flush = (to: number) => {
    if (to > run) text(s.slice(run, to));
  };
  while (i < len) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 92: {
        // backslash
        const nx = s[i + 1];
        flush(i);
        if (nx === "\n") {
          append(nodeOf({ type: "break" }, 0));
          i += 2;
          while (s[i] === " ") i++;
        } else if (nx !== undefined && PUNCT.test(nx)) {
          text(nx);
          i += 2;
        } else {
          text("\\");
          i++;
        }
        run = i;
        break;
      }
      case 96: {
        let e = i;
        while (s.charCodeAt(e) === 96) e++;
        const n = e - i;
        const close = closingRun(n, e);
        flush(i);
        if (close < 0) text(s.slice(i, e));
        else {
          let v = s.slice(e, close).replace(/\n/g, " ");
          if (v.length > 2 && v[0] === " " && v[v.length - 1] === " " && !isBlank(v)) v = v.slice(1, -1);
          append(nodeOf({ type: "codespan", value: v }, 0));
          e = close + n;
        }
        i = run = e;
        break;
      }
      case 42:
      case 95: {
        let e = i;
        while (s.charCodeAt(e) === c) e++;
        flush(i);
        const prev = i > 0 ? s[i - 1]! : "\n";
        const next = e < len ? s[e]! : "\n";
        const wsP = WS.test(prev);
        const wsN = WS.test(next);
        const puP = UPUNCT.test(prev);
        const puN = UPUNCT.test(next);
        const left = !wsN && (!puN || wsP || puP);
        const right = !wsP && (!puP || wsN || puN);
        const x = mk(2);
        x.ch = c === 42 ? "*" : "_";
        x.n = x.orig = e - i;
        x.open = c === 42 ? left : left && (!right || puP);
        x.close = c === 42 ? right : right && (!left || puN);
        append(x);
        x.dprev = dtail;
        if (dtail) dtail.dnext = x;
        else dhead = x;
        dtail = x;
        i = run = e;
        break;
      }
      case 33:
      case 91: {
        if (c === 33 && s[i + 1] !== "[") {
          i++;
          break;
        }
        flush(i);
        const img = c === 33;
        const x = mk(0, img ? "![" : "[");
        append(x);
        brackets.push({ n: x, img, src: i + (img ? 2 : 1), dBottom: dtail, serial: ++serial });
        i = run = i + (img ? 2 : 1);
        break;
      }
      case 93: {
        flush(i);
        const b = brackets[brackets.length - 1];
        if (!b || (!b.img && b.serial < linkSerial)) {
          if (b) brackets.pop();
          text("]");
          i = run = i + 1;
          break;
        }
        let href: string | null = null;
        let title: string | null = null;
        let end = i + 1;
        if (s[i + 1] === "(") {
          const t = linkTail(s, i + 2);
          if (t) ({ href, title, end } = t);
        }
        if (href === null) {
          let def: { href: string; title: string | null } | undefined;
          const own = () => (i - b.src <= MAX_LABEL ? s.slice(b.src, i) : null);
          if (s[i + 1] === "[") {
            const e = labelEnd(s, i + 2);
            if (e >= 0) {
              const lab = e === i + 2 ? own() : s.slice(i + 2, e);
              if (lab !== null) def = defs.get(normLabel(lab));
              end = e + 1;
            }
          } else {
            const lab = own();
            if (lab !== null) def = defs.get(normLabel(lab));
          }
          if (def) ({ href, title } = def);
        }
        if (href !== null) {
          processEmph(b.dBottom);
          const kids = range(b.n);
          const d = depthOf(kids);
          if (d + 1 <= MAX_DEPTH) {
            const children = toInline(kids);
            const node: Inline = b.img
              ? { type: "image", src: href, alt: plain(children), title }
              : { type: "link", href, title, children };
            // Cut the opener and everything after it, then add the finished node.
            const before = b.n.prev;
            if (before) before.next = null;
            else head = null;
            tail = before;
            append(nodeOf(node, b.img ? 0 : d + 1));
            brackets.pop();
            if (!b.img) linkSerial = serial + 1;
            i = run = end;
            break;
          }
        }
        brackets.pop();
        text("]");
        i = run = i + 1;
        break;
      }
      case 38: {
        const e = decodeEntity(s, i);
        if (e) {
          flush(i);
          text(e.str);
          i = run = i + e.len;
        } else i++;
        break;
      }
      case 10: {
        let e = i;
        while (e > run && s[e - 1] === " ") e--;
        const hard = i - e >= 2;
        flush(e);
        if (hard) append(nodeOf({ type: "break" }, 0));
        else text("\n");
        i++;
        while (s[i] === " ") i++;
        run = i;
        break;
      }
      default:
        i++;
    }
  }
  flush(len);
  processEmph(null);
  return toInline(range(null));
}

function tooLong(s: string): boolean {
  if (s.length <= MAX_LINE) return false;
  let from = 0;
  for (;;) {
    const e = s.indexOf("\n", from);
    if ((e < 0 ? s.length : e) - from > MAX_LINE) return true;
    if (e < 0) return false;
    from = e + 1;
  }
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.split(/\r\n|\r|\n/).map(expandTabs);
  const ctx: Ctx = { defs: new Map(), pending: [] };
  const { blocks } = parseBlocks(lines, 0, ctx);
  for (const { node, text } of ctx.pending) {
    node.children = !text ? [] : tooLong(text) ? [{ type: "text", value: text }] : parseInline(text, ctx.defs);
  }
  return blocks;
}
