// Incremental syntax highlighter. Each language is a small declarative spec driven by one
// generic line lexer. The lexer state at the start of every line (inside a block comment,
// inside a multi-line string, …) is a small integer cached per line, so highlighting any
// visible line only requires lexing the lines above it once.

export type Tok = "k" | "s" | "c" | "n" | "f" | "t" | "p" | "o" | "v" | "m" | "h" | "a" | "x" | "b" | "i" | "l";
// k keyword · s string · c comment · n number · f function · t type · p property · o constant
// v variable · m meta/decorator · h heading · a attribute · x tag · b bold · i italic · l link

interface Lang {
  name: string;
  line?: string[];
  block?: [string, string][];
  /** [open, close, multiline, escapes] */
  strings?: [string, string, boolean, boolean][];
  keywords?: Set<string>;
  types?: Set<string>;
  consts?: Set<string>;
  caseInsensitive?: boolean;
  /** "$var" variables (shell, php, perl) */
  dollarVars?: boolean;
  /** "@decorator" */
  at?: boolean;
  /** identifiers/strings followed by ":" are properties (json, yaml, css) */
  colonProps?: boolean;
  /** identifiers followed by "=" at line start are properties (toml, ini) */
  eqProps?: boolean;
  /** "#rgb" colors and "--vars" (css) */
  css?: boolean;
  special?: "markup" | "markdown" | "yaml";
}

const W = (s: string) => new Set(s.split(" "));

const C_LIKE_STRINGS: [string, string, boolean, boolean][] = [
  ['"', '"', false, true],
  ["'", "'", false, true],
];

const JS_KW = W(
  "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let module namespace new of package private protected public readonly return satisfies set static super switch this throw try type typeof unique var void while with yield",
);
const JS_TYPES = W("string number boolean any unknown never object symbol bigint void Array Promise Record Map Set");
const CONSTS = W("true false null undefined NaN Infinity nil None True False");

const LANGS: Record<string, Lang> = {
  js: {
    name: "JavaScript",
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [...C_LIKE_STRINGS, ["`", "`", true, true]],
    keywords: JS_KW,
    types: JS_TYPES,
    consts: CONSTS,
    at: true,
  },
  py: {
    name: "Python",
    line: ["#"],
    strings: [
      ['"""', '"""', true, true],
      ["'''", "'''", true, true],
      ...C_LIKE_STRINGS,
    ],
    keywords: W(
      "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield self cls",
    ),
    types: W("int float str bool list dict set tuple bytes object type Exception"),
    consts: CONSTS,
    at: true,
  },
  rs: {
    name: "Rust",
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [['"', '"', true, true]],
    keywords: W(
      "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while macro_rules",
    ),
    types: W("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc"),
    consts: W("true false None Some Ok Err"),
    at: false,
  },
  go: {
    name: "Go",
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [...C_LIKE_STRINGS, ["`", "`", true, false]],
    keywords: W(
      "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    ),
    types: W("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any"),
    consts: W("true false nil iota"),
  },
  c: {
    name: "C/C++",
    line: ["//"],
    block: [["/*", "*/"]],
    strings: C_LIKE_STRINGS,
    keywords: W(
      "auto break case catch class const constexpr continue default delete do else enum explicit export extern for friend goto if inline mutable namespace new noexcept operator private protected public register return sizeof static static_cast struct switch template this throw try typedef typename union using virtual volatile while #include #define #ifdef #ifndef #endif #if #else #elif #pragma #undef",
    ),
    types: W("int char float double void long short unsigned signed bool size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t std string vector"),
    consts: W("true false NULL nullptr"),
  },
  java: {
    name: "Java/Kotlin/C#",
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [['"""', '"""', true, true], ...C_LIKE_STRINGS],
    keywords: W(
      "abstract as assert base break case catch class const continue data default do else enum extends final finally for fun if implements import in interface internal is lateinit namespace new object open override package private protected public return sealed static super switch synchronized this throw throws try using val var void volatile when while yield async await",
    ),
    types: W("int long short byte char float double boolean String Int Long Boolean Unit Any Object List Map"),
    consts: CONSTS,
    at: true,
  },
  swift: {
    name: "Swift",
    line: ["//"],
    block: [["/*", "*/"]],
    strings: [['"""', '"""', true, true], ['"', '"', false, true]],
    keywords: W(
      "as associatedtype break case catch class continue default defer deinit do else enum extension fallthrough fileprivate for func guard if import in init inout internal is let open operator private protocol public repeat rethrows return self Self static struct subscript super switch throw throws try typealias var where while async await some any",
    ),
    types: W("Int Double Float String Bool Character Array Dictionary Set Optional Void"),
    consts: W("true false nil"),
    at: true,
  },
  rb: {
    name: "Ruby",
    line: ["#"],
    strings: C_LIKE_STRINGS,
    keywords: W(
      "alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require attr_accessor attr_reader",
    ),
    consts: W("true false nil"),
  },
  php: {
    name: "PHP",
    line: ["//", "#"],
    block: [["/*", "*/"]],
    strings: C_LIKE_STRINGS,
    keywords: W(
      "abstract as break case catch class const continue declare default do echo else elseif extends final finally fn for foreach function global if implements include interface match namespace new private protected public require return static switch throw trait try use var while yield",
    ),
    consts: W("true false null TRUE FALSE NULL"),
    dollarVars: true,
  },
  lua: {
    name: "Lua",
    line: ["--"],
    block: [["--[[", "]]"]],
    strings: [...C_LIKE_STRINGS, ["[[", "]]", true, false]],
    keywords: W("and break do else elseif end for function goto if in local not or repeat return then until while"),
    consts: W("true false nil"),
  },
  sh: {
    name: "Shell",
    line: ["#"],
    strings: [
      ['"', '"', true, true],
      ["'", "'", true, false],
    ],
    keywords: W(
      "if then else elif fi case esac for while until do done in function return local export readonly declare set unset shift source alias echo exit cd test",
    ),
    dollarVars: true,
  },
  sql: {
    name: "SQL",
    line: ["--"],
    block: [["/*", "*/"]],
    strings: [["'", "'", true, false]],
    caseInsensitive: true,
    keywords: W(
      "select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join left right inner outer on group by order having limit offset as distinct union all case when then else end is null in exists like between returning with default constraint unique if begin commit rollback",
    ),
    types: W("int integer bigint smallint text varchar char boolean bool date timestamp timestamptz float real double numeric decimal serial uuid json jsonb blob"),
    consts: W("true false null"),
  },
  css: {
    name: "CSS",
    block: [["/*", "*/"]],
    line: [],
    strings: C_LIKE_STRINGS,
    keywords: W("@media @import @supports @keyframes @font-face @layer @container @use @include @mixin @extend !important"),
    colonProps: true,
    css: true,
  },
  json: { name: "JSON", line: ["//"], block: [["/*", "*/"]], strings: [['"', '"', false, true]], consts: CONSTS, colonProps: true },
  yaml: {
    name: "YAML",
    line: ["#"],
    strings: C_LIKE_STRINGS,
    consts: W("true false null yes no on off ~"),
    colonProps: true,
    special: "yaml",
  },
  toml: {
    name: "TOML",
    line: ["#", ";"],
    strings: [['"""', '"""', true, true], ["'''", "'''", true, false], ...C_LIKE_STRINGS],
    consts: CONSTS,
    eqProps: true,
  },
  docker: {
    name: "Dockerfile",
    line: ["#"],
    strings: C_LIKE_STRINGS,
    caseInsensitive: true,
    keywords: W("from as run cmd label expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell"),
    dollarVars: true,
  },
  make: {
    name: "Makefile",
    line: ["#"],
    strings: C_LIKE_STRINGS,
    keywords: W("ifeq ifneq ifdef ifndef else endif include define endef export override .PHONY"),
    dollarVars: true,
  },
  zig: {
    name: "Zig",
    line: ["//"],
    strings: C_LIKE_STRINGS,
    keywords: W(
      "addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline noalias nosuspend opaque or orelse packed pub resume return struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while",
    ),
    types: W("i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 bool void type anyerror"),
    consts: W("true false null undefined"),
  },
  hs: {
    name: "Haskell",
    line: ["--"],
    block: [["{-", "-}"]],
    strings: [['"', '"', false, true]],
    keywords: W("case class data default deriving do else if import in infix infixl infixr instance let module newtype of then type where"),
    consts: W("True False Nothing Just"),
  },
  markup: { name: "HTML", special: "markup" },
  md: { name: "Markdown", special: "markdown" },
  text: { name: "Plain Text" },
};

const EXT: Record<string, string> = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", mts: "js", cts: "js", tsx: "js",
  py: "py", pyi: "py", pyw: "py",
  rs: "rs", go: "go",
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hh: "c", m: "c", mm: "c", ino: "c", glsl: "c", wgsl: "c", proto: "c",
  java: "java", kt: "java", kts: "java", cs: "java", scala: "java", groovy: "java", gradle: "java", dart: "java",
  swift: "swift", rb: "rb", rake: "rb", php: "php", lua: "lua",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh", ksh: "sh", env: "sh", ps1: "sh",
  sql: "sql", css: "css", scss: "css", sass: "css", less: "css",
  json: "json", jsonc: "json", json5: "json", lock: "json", ipynb: "json", webmanifest: "json",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "toml", cfg: "toml", conf: "toml", properties: "toml",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup", astro: "markup", plist: "markup", xsd: "markup",
  md: "md", markdown: "md", mdx: "md",
  zig: "zig", hs: "hs", elm: "hs",
};

const NAMES: Record<string, string> = {
  dockerfile: "docker", containerfile: "docker", makefile: "make", gnumakefile: "make", justfile: "make",
  ".bashrc": "sh", ".zshrc": "sh", ".profile": "sh", ".bash_profile": "sh", ".gitignore": "sh", ".env": "sh",
  "cmakelists.txt": "make", gemfile: "rb", rakefile: "rb", ".editorconfig": "toml", ".npmrc": "toml",
};

export function languageFor(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (NAMES[base]) return NAMES[base]!;
  if (base.startsWith("dockerfile")) return "docker";
  if (base.startsWith(".env")) return "sh";
  const dot = base.lastIndexOf(".");
  return (dot >= 0 && EXT[base.slice(dot + 1)]) || "text";
}

export function languageName(id: string): string {
  return LANGS[id]?.name ?? "Plain Text";
}

const NUM = /0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[a-zA-Z%]*/y;
const IDENT = /[A-Za-z_$À-￿][\w$À-￿]*[?!]?/y;
const CSS_IDENT = /-?-?[A-Za-z_][\w-]*/y;

export type Span = [number, number, Tok];

/**
 * Lexes one line. `state` encodes the multi-line construct open at line start:
 * 0 = none, 1..N = block comment i-1, 100+i = multi-line string i, 200 = markup comment,
 * 201 = markdown fence, 202 = inside a markup tag.
 */
export function lexLine(langId: string, text: string, state: number, out: Span[]): number {
  const L = LANGS[langId];
  if (!L || langId === "text") return 0;
  if (L.special === "markup") return lexMarkup(text, state, out);
  if (L.special === "markdown") return lexMarkdown(text, state, out);

  const n = text.length;
  let i = 0;

  // Continue a construct from the previous line.
  if (state > 0 && state < 100 && L.block) {
    const close = L.block[state - 1]![1];
    const e = text.indexOf(close);
    if (e < 0) {
      out.push([0, n, "c"]);
      return state;
    }
    out.push([0, e + close.length, "c"]);
    i = e + close.length;
    state = 0;
  } else if (state >= 100 && L.strings) {
    const [, close, , esc] = L.strings[state - 100]!;
    const e = findClose(text, 0, close, esc);
    if (e < 0) {
      out.push([0, n, "s"]);
      return state;
    }
    out.push([0, e, "s"]);
    i = e;
    state = 0;
  }

  if (L.special === "yaml") {
    const m = /^(\s*-?\s*)([^\s#:'"][^#:]*?|"[^"]*"|'[^']*')(\s*:)(?=\s|$)/.exec(text.slice(i));
    if (m && i === 0) {
      out.push([m[1]!.length, m[1]!.length + m[2]!.length, "p"]);
      i = m[0].length;
    }
  }
  if (L.eqProps && i === 0) {
    const sec = /^\s*\[\[?[^\]]*\]\]?/.exec(text);
    if (sec) {
      out.push([0, sec[0].length, "h"]);
      i = sec[0].length;
    } else {
      const m = /^(\s*)([\w.\-"']+)(\s*=)/.exec(text);
      if (m) {
        out.push([m[1]!.length, m[1]!.length + m[2]!.length, "p"]);
        i = m[0].length;
      }
    }
  }

  outer: while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9) {
      i++;
      continue;
    }
    if (L.line) {
      for (const lc of L.line) {
        if (text.startsWith(lc, i) && !(lc === "#" && L.css)) {
          // "#" only starts a comment at a word boundary (so "a#b" in shell is not one)
          if (lc === "#" && i > 0 && !/[\s;|&(]/.test(text[i - 1]!) && L.dollarVars) break;
          out.push([i, n, "c"]);
          return 0;
        }
      }
    }
    if (L.block) {
      for (let b = 0; b < L.block.length; b++) {
        const [open, close] = L.block[b]!;
        if (text.startsWith(open, i)) {
          const e = text.indexOf(close, i + open.length);
          if (e < 0) {
            out.push([i, n, "c"]);
            return b + 1;
          }
          out.push([i, e + close.length, "c"]);
          i = e + close.length;
          continue outer;
        }
      }
    }
    if (c === 47 /* / */ && langId === "js") {
      const end = regexLiteralEnd(text, i);
      if (end > 0) {
        out.push([i, end, "s"]);
        i = end;
        continue;
      }
    }
    if (L.strings) {
      for (let s = 0; s < L.strings.length; s++) {
        const [open, close, multi, esc] = L.strings[s]!;
        if (text.startsWith(open, i)) {
          const e = findClose(text, i + open.length, close, esc);
          if (e < 0) {
            out.push([i, n, "s"]);
            return multi ? 100 + s : 0;
          }
          // JSON/YAML-style keys: "name": value
          let tok: Tok = "s";
          // YAML: a key's colon is followed by space or the end of line; "http://" is a value.
          if (L.colonProps && (L.special === "yaml" ? /^\s*:(?=\s|$)/ : /^\s*:/).test(text.slice(e, e + 8))) tok = "p";
          out.push([i, e, tok]);
          i = e;
          continue outer;
        }
      }
    }
    if ((c >= 48 && c <= 57) || (c === 46 && i + 1 < n && /\d/.test(text[i + 1]!))) {
      const prev = i > 0 ? text.charCodeAt(i - 1) : 32;
      if (!isWordCode(prev)) {
        NUM.lastIndex = i;
        const m = NUM.exec(text);
        if (m && m[0].length) {
          out.push([i, i + m[0].length, "n"]);
          i += m[0].length;
          continue;
        }
      }
    }
    if (L.css) {
      if (c === 35 /* # */) {
        const m = /#[\da-fA-F]{3,8}\b/y;
        m.lastIndex = i;
        const r = m.exec(text);
        if (r) {
          out.push([i, i + r[0].length, "n"]);
          i += r[0].length;
          continue;
        }
      }
      if (c === 64 /* @ */ || c === 33 /* ! */) {
        const m = /[@!][\w-]+/y;
        m.lastIndex = i;
        const r = m.exec(text)!;
        if (r) {
          out.push([i, i + r[0].length, "k"]);
          i += r[0].length;
          continue;
        }
      }
      CSS_IDENT.lastIndex = i;
      const r = CSS_IDENT.exec(text);
      if (r) {
        const end = i + r[0].length;
        const after = text.slice(end).trimStart();
        // property: value; (but not a pseudo-class like a:hover {)
        if (after.startsWith(":") && /;|^\s*:[^{]*$/.test(after)) out.push([i, end, "p"]);
        else if (r[0].startsWith("--")) out.push([i, end, "v"]);
        else if (after.startsWith("(")) out.push([i, end, "f"]);
        i = end;
        continue;
      }
    }
    if (L.dollarVars && c === 36 /* $ */) {
      const m = /\$(?:\{[^}]*\}|\(|[\w@#?*!$-]+)/y;
      m.lastIndex = i;
      const r = m.exec(text);
      if (r) {
        out.push([i, i + r[0].length, "v"]);
        i += r[0].length;
        continue;
      }
    }
    if (L.at && c === 64 /* @ */) {
      const m = /@[\w.]+/y;
      m.lastIndex = i;
      const r = m.exec(text);
      if (r) {
        out.push([i, i + r[0].length, "m"]);
        i += r[0].length;
        continue;
      }
    }
    if (c === 35 /* # */ && langId === "c") {
      const m = /#\s*\w+/y;
      m.lastIndex = i;
      const r = m.exec(text);
      if (r) {
        out.push([i, i + r[0].length, "m"]);
        i += r[0].length;
        continue;
      }
    }
    IDENT.lastIndex = i;
    const id = isIdentStart(c) ? IDENT.exec(text) : null;
    if (id) {
      const w = id[0];
      const key = L.caseInsensitive ? w.toLowerCase() : w;
      const end = i + w.length;
      let tok: Tok | null = null;
      const prevCh = i > 0 ? text[i - 1] : "";
      if (L.keywords?.has(key) && prevCh !== ".") tok = "k";
      else if (L.consts?.has(key)) tok = "o";
      else if (L.types?.has(key)) tok = "t";
      else {
        let j = end;
        while (j < n && text.charCodeAt(j) === 32) j++;
        const next = text[j];
        if (next === "(" || (next === "!" && langId === "rs" && text[j + 1] === "(")) tok = "f";
        // YAML keys end in ": " or ":" at the end of the line; "http://" inside a value is not a key.
        else if (L.colonProps && next === ":" && text[j + 1] !== ":" && (L.special !== "yaml" || j + 1 >= n || /\s/.test(text[j + 1]!))) tok = "p";
        else if (/^[A-Z][a-z0-9]/.test(w) && langId !== "sql") tok = "t";
        else if (/^[A-Z][A-Z0-9_]+$/.test(w) && w.length > 1) tok = "o";
        else if (prevCh === "." && langId !== "sql") tok = null;
      }
      if (tok) out.push([i, end, tok]);
      i = end;
      continue;
    }
    i++;
  }
  return 0;
}

const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);

/**
 * JS/TS: if the "/" at `i` starts a regex literal (by what precedes it), returns the index
 * just past it (including flags); otherwise 0. Handles escapes and character classes.
 */
function regexLiteralEnd(text: string, i: number): number {
  const next = text[i + 1];
  if (next === "/" || next === "*") return 0;
  const before = text.slice(0, i).trimEnd();
  const last = before[before.length - 1];
  if (last !== undefined && !"(,=:[!&|?{};+-*%<>~^".includes(last)) {
    const word = /[A-Za-z_$][\w$]*$/.exec(before)?.[0];
    if (!word || !REGEX_AFTER_WORD.has(word)) return 0; // division: a / b, x) / 2, arr[i] / n
  }
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      j++;
      while (j < text.length && /[a-z]/i.test(text[j]!)) j++;
      return j;
    }
  }
  return 0; // unterminated on this line: not a regex
}

function isWordCode(c: number) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

function isIdentStart(c: number) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c >= 0xc0;
}

/** Index just past the closing delimiter, or -1. */
function findClose(text: string, from: number, close: string, esc: boolean): number {
  for (let i = from; i < text.length; i++) {
    if (esc && text.charCodeAt(i) === 92) {
      i++;
      continue;
    }
    if (text.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

function lexMarkup(text: string, state: number, out: Span[]): number {
  const n = text.length;
  let i = 0;
  if (state === 200) {
    const e = text.indexOf("-->");
    if (e < 0) {
      out.push([0, n, "c"]);
      return 200;
    }
    out.push([0, e + 3, "c"]);
    i = e + 3;
  }
  let inTag = state === 202;
  while (i < n) {
    if (!inTag) {
      const lt = text.indexOf("<", i);
      if (lt < 0) break;
      i = lt;
      if (text.startsWith("<!--", i)) {
        const e = text.indexOf("-->", i + 4);
        if (e < 0) {
          out.push([i, n, "c"]);
          return 200;
        }
        out.push([i, e + 3, "c"]);
        i = e + 3;
        continue;
      }
      const m = /<\/?[\w:.-]+|<[!?][\w-]*/y;
      m.lastIndex = i;
      const r = m.exec(text);
      if (!r) {
        i++;
        continue;
      }
      out.push([i, i + r[0].length, "x"]);
      i += r[0].length;
      inTag = true;
      continue;
    }
    const c = text[i]!;
    if (c === ">" || text.startsWith("/>", i) || text.startsWith("?>", i)) {
      const len = c === ">" ? 1 : 2;
      out.push([i, i + len, "x"]);
      i += len;
      inTag = false;
      continue;
    }
    if (c === '"' || c === "'") {
      const e = text.indexOf(c, i + 1);
      const end = e < 0 ? n : e + 1;
      out.push([i, end, "s"]);
      i = end;
      continue;
    }
    const m = /[^\s=>/"']+/y;
    m.lastIndex = i;
    const r = m.exec(text);
    if (r) {
      out.push([i, i + r[0].length, "a"]);
      i += r[0].length;
      continue;
    }
    i++;
  }
  return inTag ? 202 : 0;
}

function lexMarkdown(text: string, state: number, out: Span[]): number {
  const fence = /^\s*(```|~~~)/.test(text);
  if (state === 201) {
    out.push([0, text.length, "s"]);
    return fence ? 0 : 201;
  }
  if (fence) {
    out.push([0, text.length, "s"]);
    return 201;
  }
  const h = /^#{1,6}\s/.exec(text);
  if (h) {
    out.push([0, text.length, "h"]);
    return 0;
  }
  if (/^\s*>/.test(text)) {
    out.push([0, text.length, "c"]);
    return 0;
  }
  const lm = /^\s*([-*+]|\d+[.)])\s/.exec(text);
  if (lm) out.push([lm.index + lm[0].indexOf(lm[1]!), lm[0].length, "k"]);
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|((?<![\w*])\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_)|(!?\[[^\]]*\]\([^)]*\))|(<https?:[^>]+>)/g;
  for (let m; (m = re.exec(text)); ) {
    const tok: Tok = m[1] ? "s" : m[2] ? "b" : m[3] ? "i" : "l";
    out.push([m.index, m.index + m[0].length, tok]);
  }
  return 0;
}

/**
 * Per-document highlighter: caches the lexer state at each line start and lazily
 * advances it, so the cost of highlighting line N is paid once.
 */
export class Highlighter {
  private states: Int32Array;
  private known = 1; // states[0..known) are valid
  private spans: Span[] = [];

  constructor(
    readonly lang: string,
    private lines: string[],
  ) {
    this.states = new Int32Array(lines.length + 1);
  }

  /** Tokens for line `idx`, sorted and non-overlapping. */
  line(idx: number): Span[] {
    if (this.lang === "text") return [];
    const lines = this.lines;
    if (idx >= this.known) {
      const scratch: Span[] = [];
      for (let i = this.known - 1; i < idx; i++) {
        scratch.length = 0;
        this.states[i + 1] = lines[i]!.length > 10_000 ? 0 : lexLine(this.lang, lines[i]!, this.states[i]!, scratch);
      }
      this.known = idx + 1;
    }
    const out = this.spans;
    out.length = 0;
    const text = lines[idx]!;
    if (text.length > 10_000) return [];
    lexLine(this.lang, text, this.states[idx]!, out);
    return out.slice().sort((a, b) => a[0] - b[0]);
  }
}
