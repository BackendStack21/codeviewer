// Pure Markdown parser: no DOM, no dependencies, linear time. Block pass is line-oriented.

export interface Text {
  type: "text";
  value: string;
}
export type Inline = Text;
export interface Heading {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: Inline[];
}
export interface Paragraph {
  type: "paragraph";
  children: Inline[];
}
export type Block = Heading | Paragraph;

/** True for `.md` / `.markdown` paths, case-insensitive. */
export function isMarkdown(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return name.endsWith(".md") || name.endsWith(".markdown");
}

const isWs = (c: string | undefined) => c === " " || c === "\t";

/** ATX heading: up to 3 spaces, 1-6 `#`, then whitespace or end of line. */
function atx(line: string): Heading | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
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
  return { type: "heading", level: n as Heading["level"], children: text ? [{ type: "text", value: text }] : [] };
}

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", children: [{ type: "text", value: para.join("\n") }] });
    para = [];
  };
  for (const raw of src.split(/\r\n|\r|\n/)) {
    if (raw.trim() === "") {
      flush();
      continue;
    }
    const hd = atx(raw);
    if (hd) {
      flush();
      blocks.push(hd);
    } else para.push(raw.trim());
  }
  flush();
  return blocks;
}
