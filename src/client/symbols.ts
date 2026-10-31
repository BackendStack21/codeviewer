// Go to Symbol: a file's outline from per-language patterns over its lines. Pure, no DOM.
//
// This is a reading aid, not a parser: one pattern per declaration form, matched at the start of a
// line, with comment lines and (for brace languages) block comments skipped. Nesting is the
// indentation, which is what a reader sees anyway.

export type SymbolKind = "function" | "class" | "type" | "variable" | "heading" | "section";

export interface Sym {
  name: string;
  kind: SymbolKind;
  /** 0-based line. */
  line: number;
  /** Leading whitespace width (tabs count 4), or the heading level - 1 for Markdown. */
  depth: number;
}

type Rule = [RegExp, SymbolKind];

/** Each pattern runs on the line without its indentation; group 1 is the name. */
const RULES: Record<string, Rule[]> = {
  js: [
    [/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)/, "class"],
    [/^(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace|module)\s+([\w$]+)/, "type"],
    [/^(?:export\s+)?(?:const\s+)?enum\s+([\w$]+)/, "type"],
    [/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, "function"],
    [/^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/, "function"],
    [/^(?:export\s+)(?:const|let|var)\s+([\w$]+)/, "variable"],
    // Class members: `name(…) {`, `async name(…)`, `get name()`, `private static name = (…) =>`.
    [/^(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*(?:\*\s*)?(?!(?:if|for|while|switch|catch|return|function|new|await|typeof|else|do|super|this)\b)([\w$#]+)\s*(?:<[^>]*>)?\([^;]*\)\s*(?::\s*[^={;]+)?\{\s*(?:\}\s*)?$/, "function"],
    [/^(?:(?:public|private|protected|static|readonly|override)\s+)+([\w$#]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>/, "function"],
  ],
  py: [
    [/^class\s+(\w+)/, "class"],
    [/^(?:async\s+)?def\s+(\w+)/, "function"],
  ],
  rs: [
    [/^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/, "function"],
    [/^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union|trait|type)\s+(\w+)/, "type"],
    [/^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/, "section"],
    [/^(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(.+?)\s*(?:where\b.*)?\{?\s*$/, "class"],
    [/^macro_rules!\s*(\w+)/, "function"],
  ],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, "function"],
    [/^type\s+(\w+)\s+(?:struct|interface)/, "class"],
    [/^type\s+(\w+)/, "type"],
  ],
  c: [
    [/^(?:class|struct|union|enum(?:\s+class)?)\s+(?:\w+\s+)*?(\w+)\s*(?:final\s*)?(?::[^;{]*)?\{?\s*$/, "class"],
    [/^namespace\s+(\w+)/, "section"],
    [/^#define\s+(\w+)/, "variable"],
    // A definition: a return type, the name, a parameter list, and no `;` (that would be a prototype).
    [/^(?!(?:if|for|while|switch|return|else|do|case|sizeof|delete|new)\b)(?:[\w:*&<>,~]+\s+)+\**&?((?:\w+::)*~?\w+)\s*\([^;]*$/, "function"],
  ],
  java: [
    [/^(?:(?:public|private|protected|internal|abstract|final|sealed|open|data|static|partial|inner|enum|annotation)\s+)*(?:class|interface|enum|record|object|trait|struct)\s+(\w+)/, "class"],
    [/^(?:(?:public|private|protected|internal|override|open|suspend|inline|static|final)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/, "function"],
    [/^(?:(?:public|private|protected|internal|override|implicit|final)\s+)*def\s+(\w+)/, "function"],
    [/^(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async|default)\s+)+(?:<[^>]*>\s*)?[\w<>[\],.?\s]+?\s+(\w+)\s*\([^;]*$/, "function"],
  ],
  swift: [
    [/^(?:(?:public|private|fileprivate|internal|open|final|indirect)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+(\w+)/, "class"],
    [/^(?:(?:public|private|fileprivate|internal|open|override|static|class|final|mutating|@\w+)\s+)*func\s+(\w+)/, "function"],
    [/^(?:(?:public|private|fileprivate|internal)\s+)*typealias\s+(\w+)/, "type"],
  ],
  rb: [
    [/^(?:class|module)\s+([\w:]+)/, "class"],
    [/^def\s+((?:self\.)?[\w?!=]+)/, "function"],
  ],
  php: [
    [/^(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(\w+)/, "class"],
    [/^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?(\w+)/, "function"],
  ],
  lua: [[/^(?:local\s+)?function\s+([\w.:]+)/, "function"], [/^(?:local\s+)?([\w.]+)\s*=\s*function\b/, "function"]],
  sh: [[/^(?:function\s+)?([\w.:-]+)\s*\(\)\s*\{?/, "function"], [/^function\s+([\w.:-]+)/, "function"]],
  css: [[/^(@media[^{]*|@keyframes\s+[\w-]+|@layer\s+[\w-]+|@supports[^{]*)\{?/, "section"], [/^([.#]?[\w-][^{;,]*?)\s*\{\s*$/, "class"]],
  make: [[/^([\w.%/-]+)\s*:(?!=)/, "function"]],
  zig: [
    [/^(?:pub\s+)?(?:export\s+|inline\s+)?fn\s+(\w+)/, "function"],
    [/^(?:pub\s+)?const\s+(\w+)\s*=\s*(?:packed\s+|extern\s+)?(?:struct|enum|union|opaque)\b/, "class"],
    [/^test\s+"([^"]*)"/, "function"],
  ],
  hs: [[/^(?:data|newtype|type|class)\s+(\w+)/, "type"], [/^([a-z_][\w']*)\s*::/, "function"]],
  toml: [[/^\[\[?\s*([^\]]+?)\s*\]\]?/, "section"]],
  yaml: [[/^([\w.-]+):(?:\s|$)/, "section"]],
  docker: [[/^FROM\s+\S+(?:\s+AS\s+(\S+))?/i, "section"]],
};

/** Languages whose `#` starts a comment (everything else here uses `//`, `--` or `;`). */
const HASH_COMMENT = new Set(["py", "rb", "sh", "make", "toml", "yaml", "docker"]);
const BLOCK_COMMENT = new Set(["js", "rs", "go", "c", "java", "swift", "php", "css", "zig"]);
/** Only top-level keys (no indentation) count as symbols in these. */
const TOP_LEVEL_ONLY = new Set(["yaml", "make", "docker", "toml"]);

/** Lines this long are minified or data: no symbols are looked for there. */
const MAX_LINE = 1000;
/** Large generated files would make the list useless; stop here. */
export const MAX_SYMBOLS = 5000;

function indentOf(s: string): number {
  let w = 0;
  for (const c of s) {
    if (c === " ") w++;
    else if (c === "\t") w += 4;
    else break;
  }
  return w;
}

export function hasSymbols(lang: string): boolean {
  return lang === "md" || lang in RULES;
}

/** The outline of `lines` in language `lang` (a highlighter language id). */
export function symbols(lang: string, lines: readonly string[]): Sym[] {
  if (lang === "md") return mdHeadings(lines);
  const rules = RULES[lang];
  if (!rules) return [];
  const out: Sym[] = [];
  const hash = HASH_COMMENT.has(lang);
  const blocks = BLOCK_COMMENT.has(lang);
  let inBlock = false;
  let pyString: string | null = null;
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    const raw = lines[i]!;
    if (raw.length > MAX_LINE) continue;
    const t = raw.trimStart();
    if (blocks) {
      if (inBlock) {
        if (t.includes("*/")) inBlock = false;
        continue;
      }
      if (t.startsWith("/*")) {
        inBlock = !t.includes("*/", 2);
        continue;
      }
    }
    if (lang === "py") {
      // Docstrings: skip their lines so prose like "class of objects" is not taken for code.
      if (pyString) {
        if (t.includes(pyString)) pyString = null;
        continue;
      }
      const q = /^[rRbBuUfF]*("""|''')/.exec(t);
      if (q && !t.slice(q[0].length).includes(q[1]!)) {
        pyString = q[1]!;
        continue;
      }
    }
    if (!t || t.startsWith("//") || t.startsWith("*") || (hash && t.startsWith("#")) || ((lang === "lua" || lang === "hs" || lang === "sql") && t.startsWith("--"))) continue;
    const depth = indentOf(raw);
    if (depth > 0 && TOP_LEVEL_ONLY.has(lang)) continue;
    for (const [re, kind] of rules) {
      const m = re.exec(t);
      if (m && m[1]) {
        out.push({ name: m[1].trim(), kind, line: i, depth });
        break;
      }
    }
  }
  return out;
}

/** ATX and setext headings outside fenced code. */
function mdHeadings(lines: readonly string[]): Sym[] {
  const out: Sym[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    const l = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !l.slice(f[0].length).trim()) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      continue;
    }
    const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(l);
    if (m) {
      const name = (m[2] ?? "").trim();
      if (name) out.push({ name, kind: "heading", line: i, depth: m[1]!.length - 1 });
      continue;
    }
    // Setext: a paragraph line followed by === or ---.
    const next = lines[i + 1];
    if (next !== undefined && l.trim() && !/^ {4}/.test(l) && /^ {0,3}(=+|-+)[ \t]*$/.test(next) && !/^\s*([-*+]|\d+[.)])\s/.test(l) && !/^ {0,3}>/.test(l)) {
      out.push({ name: l.trim(), kind: "heading", line: i, depth: next.trim()[0] === "=" ? 0 : 1 });
      i++;
    }
  }
  return out;
}

/** Heading text as it renders (for the slug): emphasis, code ticks and link targets dropped. */
export function headingText(src: string): string {
  return src
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}
