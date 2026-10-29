import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

/** Strip /* ... *\/ comments by scanning characters. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else out += src[i++];
  }
  return out;
}

type Rule = { sels: string[]; decls: { prop: string; value: string }[] };

/** Innermost `selector { body }` blocks; at-rule wrappers are skipped. */
function parseRules(src: string): Rule[] {
  const out: Rule[] = [];
  let head = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "{") {
      const close = src.indexOf("}", i + 1);
      const inner = src.slice(i + 1, close);
      if (inner.includes("{")) {
        // at-rule wrapper: descend into it
        head = "";
        i++;
        continue;
      }
      const decls = inner
        .split(";")
        .map((d) => {
          const k = d.indexOf(":");
          return k < 0 ? null : { prop: d.slice(0, k).trim().toLowerCase(), value: d.slice(k + 1).trim() };
        })
        .filter((d): d is { prop: string; value: string } => d !== null && d.prop !== "");
      out.push({ sels: head.split(",").map((s) => s.trim()).filter(Boolean), decls });
      head = "";
      i = close + 1;
    } else if (c === "}") {
      head = "";
      i++;
    } else {
      head += c;
      i++;
    }
  }
  return out;
}

const rules = parseRules(stripComments(css));
const value = (r: Rule, prop: string) => r.decls.find((d) => d.prop === prop)?.value;
const noneRules = rules.filter((r) => value(r, "user-select")?.startsWith("none"));

describe("unselectable chrome in WebKit/Chromium (AC-11)", () => {
  test("the stylesheet has user-select: none rules to check", () => {
    expect(noneRules.length).toBeGreaterThanOrEqual(9);
  });

  test("every user-select: none rule also declares -webkit-user-select: none", () => {
    const missing = noneRules.filter((r) => !(value(r, "-webkit-user-select") ?? "").startsWith("none")).map((r) => r.sels.join(", "));
    expect(missing).toEqual([]);
  });

  test("!important matches between the prefixed and unprefixed declarations", () => {
    const bad = noneRules
      .filter((r) => (value(r, "user-select") ?? "").includes("!important") !== (value(r, "-webkit-user-select") ?? "").includes("!important"))
      .map((r) => r.sels.join(", "));
    expect(bad).toEqual([]);
  });

  test("gutter, blame and trunc rules are among the covered ones", () => {
    for (const sel of [".ln .g", ".blame", ".trunc"]) {
      const r = noneRules.find((x) => x.sels.includes(sel));
      expect(r, sel).toBeDefined();
      expect(value(r!, "-webkit-user-select"), sel).toBe("none");
    }
  });

  test("transparent ::selection backstop covers .ln .g, .blame and .trunc", () => {
    for (const base of [".ln .g", ".blame", ".trunc"]) {
      const r = rules.find((x) => x.sels.includes(`${base}::selection`));
      expect(r, base).toBeDefined();
      expect(value(r!, "background"), base).toBe("transparent");
    }
  });
});
