import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { installDom, uninstallDom } from "./helpers/fakedom.ts";

let u: typeof import("../src/client/util.ts");
beforeAll(async () => {
  installDom();
  u = await import("../src/client/util.ts?hidden");
});
afterAll(() => uninstallDom());

describe("AC-19 shared HIDDEN rule in util.ts", () => {
  test("HIDDEN is a global RegExp matching C0/C1 controls and bidi overrides", () => {
    expect(u.HIDDEN).toBeInstanceOf(RegExp);
    expect(u.HIDDEN.global).toBe(true);
    for (const c of [
      "\x00",
      "\x01",
      "\x1f",
      "\x7f",
      "\x85",
      "\x9f",
      "\u202a",
      "\u202e",
      "\u2066",
      "\u2069",
    ]) {
      expect(("a" + c + "b").replace(u.HIDDEN, "#")).toBe("a#b");
    }
  });

  test("HIDDEN leaves printable text alone", () => {
    expect("héllo wörld ✓ 日本 /path".replace(u.HIDDEN, "#")).toBe(
      "héllo wörld ✓ 日本 /path",
    );
    expect(" ~\xa0\xa1".replace(u.HIDDEN, "#")).toBe(" ~\xa0\xa1");
  });

  test("showHidden writes escapes: \\xNN below 256, \\uNNNN above", () => {
    expect(u.showHidden("a\x01b")).toBe("a\\x01b");
    expect(u.showHidden("a\x7fb\x85")).toBe("a\\x7fb\\x85");
    expect(u.showHidden("a\u202eb")).toBe("a\\u202eb");
    expect(u.showHidden("\u2066x\u2069")).toBe("\\u2066x\\u2069");
    expect(u.showHidden("plain text")).toBe("plain text");
  });

  test("search.ts uses the shared rule instead of its own copy", () => {
    const src = readFileSync(
      new URL("../src/client/search.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/const HIDDEN\s*=/);
    expect(src).toMatch(
      /import[^;]*\bHIDDEN\b[^;]*from "\.\/util\.ts"|import[^;]*\bshowHidden\b[^;]*from "\.\/util\.ts"/,
    );
  });
});

describe("file contents keep their tabs; names do not", () => {
  test("showHiddenText leaves tabs but escapes every other HIDDEN character", () => {
    expect(u.showHiddenText("\tfoo\tbar")).toBe("\tfoo\tbar");
    expect(u.showHiddenText("a\x01b\u202ec\r")).toBe("a\\x01b\\u202ec\\x0d");
    expect(u.showHidden("\tname")).toBe("\\x09name");
  });

  test("esc escapes both quote characters", () => {
    expect(u.esc(`<a title='x' b="y">&`)).toBe("&lt;a title=&#39;x&#39; b=&quot;y&quot;&gt;&amp;");
  });

  test("diff lines show tabs as tabs", async () => {
    const d = await import("../src/client/diffview.ts");
    expect(d.spansHtml("\tx = 1", [])).toBe("\tx = 1");
  });

  test("the code view isolates bidi controls in place (Trojan Source) without changing the text", async () => {
    const c = await import("../src/client/codeview.ts");
    const html = c.markBidi("/*\u202e } \u2066if (isAdmin)\u2069 */");
    expect(html).toBe(
      '/*<span class="bidi" title="U+202E">\u202e</span> } <span class="bidi" title="U+2066">\u2066</span>if (isAdmin)<span class="bidi" title="U+2069">\u2069</span> */',
    );
    // Removing exactly the wrapper markBidi adds gives the input back: the text is unchanged.
    const unwrapped = html.split("</span>").join("").split(/<span class="bidi" title="U\+[0-9A-F]{4}">/).join("");
    expect(unwrapped).toBe("/*\u202e } \u2066if (isAdmin)\u2069 */");
    expect(c.markBidi("plain &amp; text")).toBe("plain &amp; text");
  });
});

describe("bidi markers stay bounded (a file of U+202E lines once made 248 000 elements)", () => {
  test("one marker per run, at most MAX_BIDI_MARKS per line, escapes after that", async () => {
    const c = await import("../src/client/codeview.ts");
    const run = c.markBidi("a\u202e\u202e\u202eb");
    expect(run.match(/class="bidi"/g)!.length).toBe(1);
    const many = c.markBidi("a\u202e".repeat(100), { left: c.MAX_BIDI_MARKS });
    expect(many.match(/class="bidi"/g)!.length).toBe(c.MAX_BIDI_MARKS);
    expect(many).toContain("\\u202e"); // the rest as visible escapes
    // Raw controls appear only inside the marked runs (one each here), never past the budget.
    const raw = [...many].filter((ch) => /[\u202a-\u202e\u2066-\u2069]/.test(ch)).length;
    expect(raw).toBe(c.MAX_BIDI_MARKS);
  });
});
