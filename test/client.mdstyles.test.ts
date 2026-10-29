import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// AC-17: every colour in the new GFM rules must come from an existing theme token.
const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

/** Returns [selector, body] for every rule whose selector list mentions `needle`. */
function rulesFor(needle: RegExp): [string, string][] {
  const out: [string, string][] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const sel = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (needle.test(sel)) out.push([sel, m[2]!]);
  }
  return out;
}

const tokens = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]!));
const GFM = /\.md-doc\s+(table|thead|tbody|tr|th|td|del|input)\b|\.md-align-|\.md-task/;

describe("AC-15/16/17 theme-token styles", () => {
  test("styles exist for table, th, td and del under .md-doc", () => {
    for (const el of ["table", "th", "td", "del"]) {
      expect(rulesFor(new RegExp(`\\.md-doc\\s+${el}\\b`)).length).toBeGreaterThan(0);
    }
  });

  test("alignment classes are styled", () => {
    for (const a of ["center", "right"]) expect(rulesFor(new RegExp(`\\.md-align-${a}\\b`)).length).toBeGreaterThan(0);
    const body = rulesFor(/\.md-align-center\b/).map((r) => r[1]).join("");
    expect(body).toContain("text-align");
  });

  test("tables have hairline borders from the border tokens", () => {
    const body = rulesFor(/\.md-doc\s+(table|th|td)\b/).map((r) => r[1]).join("\n");
    expect(body).toMatch(/border[^;]*var\(--border(-strong)?\)/);
  });

  test("the added rules contain no hex, rgb or hsl colour literals", () => {
    const rules = rulesFor(GFM);
    expect(rules.length).toBeGreaterThan(0);
    for (const [sel, body] of rules) {
      expect(body, sel).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(body, sel).not.toMatch(/\b(rgba?|hsla?)\(/);
    }
  });

  test("every var() used by the added rules is a defined theme token", () => {
    for (const [sel, body] of rulesFor(GFM)) {
      for (const m of body.matchAll(/var\((--[\w-]+)/g)) expect(tokens.has(m[1]!), `${sel} uses ${m[1]}`).toBe(true);
    }
  });

  test("no inline style is needed: rules never rely on the style attribute", () => {
    expect(css).not.toMatch(/\.md-doc[^{]*\[style/);
  });
});
