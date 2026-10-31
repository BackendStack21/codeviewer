import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let M: typeof import("../src/client/markdown.ts");
let R: typeof import("../src/client/mdrender.ts");
let V: typeof import("../src/client/mdview.ts");
beforeAll(async () => {
  installDom();
  try {
    M = await import("../src/client/markdown.ts");
    R = await import("../src/client/mdrender.ts");
    V = await import("../src/client/mdview.ts");
  } catch {}
});
afterAll(() => uninstallDom());

/** Deterministic PRNG so a failure reproduces from its seed. */
function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  "# ", "## ", "###### ", "*", "**", "_", "__", "`", "``", "```", "```js\n", "~~", "[", "]", "(", ")", "![", "](", "<", ">",
  "<script>", "</script>", "<img onerror=x>", "<iframe src=x>", "<style>", "<!-- c -->", "&", "&#x6A;", "&amp;", "&lt;",
  "javascript:", "JaVaScRiPt:", "java\tscript:", "vbscript:", "data:text/html,x", "file:///etc/passwd", "blob:x", "//evil.test/x",
  "https://a.example/b.png", "http://a.b/c", "mailto:a@b.co", "<https://x.y>", "img/a.png", "../a.png", "../../a.png", ".env",
  "/api/raw?path=.env", "x.md#sec", "#frag", "#", "|", "|---|:-:|", "---", "===", "- ", "* ", "1. ", "- [x] ", "- [ ] ", "> ",
  "\n", "\n\n", " ", "    ", "\t", "\\", "\u0001", "‮", "​", "name=", "id=", "style=", "onclick=", "on", "\"", "'", "alt", "title",
];

function gen(rnd: () => number): string {
  const n = 1 + Math.floor(rnd() * 60);
  let s = "";
  for (let i = 0; i < n; i++) s += TOKENS[Math.floor(rnd() * TOKENS.length)]!;
  return s;
}

const TAGS = new Set([
  "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td",
  "a", "img", "em", "strong", "del", "hr", "br", "span", "input",
]);
const BAD_SCHEME = /^\s*(javascript|data|vbscript|file|blob):/i;

function check(root: FakeElement, seed: number, allowBlob: boolean) {
  const where = `seed ${seed}`;
  const walk = (e: FakeElement) => {
    const tag = e.tag.toLowerCase();
    expect(TAGS.has(tag), `${where}: tag ${tag}`).toBe(true);
    expect(["script", "iframe", "object", "style", "embed", "link", "meta", "svg"].includes(tag), where).toBe(false);
    for (const [k, v] of e.attrs) {
      expect(k.startsWith("on"), `${where}: attr ${k}`).toBe(false);
      expect(["style", "srcdoc", "name"].includes(k), `${where}: attr ${k}`).toBe(false);
      if (k === "id") expect(v.startsWith("md-"), `${where}: id ${v}`).toBe(true);
      if (k === "href" || k === "src") {
        const blobOk = allowBlob && k === "src" && tag === "img" && /^blob:/.test(v);
        if (!blobOk) expect(BAD_SCHEME.test(v), `${where}: ${k}=${v}`).toBe(false);
        // An external http(s) URL may contain any path (it is a link to another origin); everything else must never address the API.
        if (k === "src" || !/^https?:/i.test(v)) expect(v.includes("/api/"), `${where}: ${k}=${v}`).toBe(false);
        if (k === "src") expect(allowBlob && /^blob:/.test(v), `${where}: src=${v}`).toBe(true);
      }
    }
    if (tag === "span") expect(/^(tok-|md-)/.test(e.className), `${where}: span ${e.className}`).toBe(true);
    if (tag === "input") {
      expect(e.getAttribute("type")).toBe("checkbox");
      expect(e.attrs.has("disabled")).toBe(true);
    }
    for (const c of e.children) if ("tag" in c) walk(c);
  };
  walk(root);
}

describe("AC-24 seeded fuzz of the safety invariants", () => {
  test("2000 random Markdown strings render without throwing and keep the tree safe", () => {
    const rnd = mulberry32(0x5eed);
    for (let i = 0; i < 2000; i++) {
      const src = gen(rnd);
      let el: FakeElement;
      try {
        el = R.renderMarkdown(M.parseMarkdown(src), { base: "docs" }) as unknown as FakeElement;
      } catch (e) {
        throw new Error(`iteration ${i} threw for ${JSON.stringify(src)}: ${e}`);
      }
      check(el, i, false);
    }
  });

  test("300 strings through MarkdownView with images enabled keep only blob srcs", async () => {
    const m = mockFetch(() => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
    const oc = URL.createObjectURL;
    const or = URL.revokeObjectURL;
    let n = 0;
    URL.createObjectURL = (() => `blob:fuzz/${++n}`) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    try {
      const rnd = mulberry32(0xf00d);
      const views: { v: InstanceType<typeof V.MarkdownView>; i: number }[] = [];
      for (let i = 0; i < 300; i++) views.push({ v: new V.MarkdownView((i % 3 === 0 ? "![a](img/a.png)\n\n" : "") + gen(rnd), 13, { path: "docs/a.md" }), i });
      await new Promise((r) => setTimeout(r, 60));
      expect(n).toBeGreaterThanOrEqual(100); // relative images really load in this run
      for (const { v, i } of views) check(v.el as FakeElement, i, true);
      for (const { v } of views) v.dispose();
      // no request ever targets a non-image or escaping path
      // (and every one carries the preview's size cap)
      for (const c of m.calls) expect(c.url).toMatch(/^\/api\/raw\?path=[^&]*\.(a?png|jpe?g|jpe|jfif|gif|webp|avif|bmp|ico|svg|tiff?|hei[cf])&max=20971520$/i);
    } finally {
      m.restore();
      URL.createObjectURL = oc;
      URL.revokeObjectURL = or;
    }
  });

  test("the fuzz generator is deterministic", () => {
    const a = gen(mulberry32(7));
    const b = gen(mulberry32(7));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
