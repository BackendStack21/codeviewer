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
      "‪",
      "‮",
      "⁦",
      "⁩",
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
    expect(u.showHidden("a‮b")).toBe("a\\u202eb");
    expect(u.showHidden("⁦x⁩")).toBe("\\u2066x\\u2069");
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
    expect(u.showHiddenText("a\x01b‮c\r")).toBe("a\\x01b\\u202ec\\x0d");
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
    const html = c.markBidi("/*‮ } ⁦if (isAdmin)⁩ */");
    expect(html).toBe(
      '/*<span class="bidi" title="U+202E">‮</span> } <span class="bidi" title="U+2066">⁦</span>if (isAdmin)<span class="bidi" title="U+2069">⁩</span> */',
    );
    expect(html.replace(/<[^>]+>/g, "")).toBe("/*‮ } ⁦if (isAdmin)⁩ */");
    expect(c.markBidi("plain &amp; text")).toBe("plain &amp; text");
  });
});
