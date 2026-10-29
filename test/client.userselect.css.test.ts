import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { textOf } from "../src/client/selection.ts";

const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Innermost `selector { body }` blocks (at-rule wrappers are skipped). */
function rules(src: string): { sel: string; body: string }[] {
  const out: { sel: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ sel: m[1]!.trim(), body: m[2]! });
  return out;
}
const all = rules(css);
/** Value of declaration `prop` in a rule body, matched by exact property name. */
const decl = (body: string, prop: string) => {
  for (const d of body.split(";")) {
    const i = d.indexOf(":");
    if (i > 0 && d.slice(0, i).trim() === prop) return d.slice(i + 1).trim();
  }
};

describe("user-select prefix (AC-1)", () => {
  const nones = all.filter((r) => /(^|[;\s])user-select\s*:\s*none/.test(r.body));
  test("the stylesheet declares user-select: none in several rules", () => {
    expect(nones.length).toBeGreaterThanOrEqual(9);
  });
  test("every user-select: none rule also declares -webkit-user-select: none, !important matching", () => {
    const missing = nones
      .filter((r) => {
        const plain = decl(r.body, "user-select")!;
        const pre = decl(r.body, "-webkit-user-select");
        return pre !== plain;
      })
      .map((r) => r.sel);
    expect(missing).toEqual([]);
  });
});

describe("gutter and labels (AC-2)", () => {
  test(".ln .g::selection is transparent", () => {
    const r = all.find((x) => x.sel.split(",").map((s) => s.trim()).includes(".ln .g::selection"));
    expect(r).toBeDefined();
    expect(decl(r!.body, "background")).toBe("transparent");
  });
  test("blame and truncation labels carry -webkit-user-select: none", () => {
    for (const sel of [".blame", ".trunc", ".ln .g"]) {
      const rs = all.filter((x) => x.sel.split(",").map((s) => s.trim()).includes(sel));
      expect(rs.some((x) => decl(x.body, "-webkit-user-select") === "none")).toBe(true);
    }
  });
});

describe("text copy excludes line numbers (AC-15)", () => {
  test("textOf over numbered lines returns only the code", () => {
    const lines = ["15 const a = 1;", "16 const b = 2;", "17 const c = 3;"];
    const out = textOf(lines, { start: { line: 0, col: 3 }, end: { line: 2, col: 15 } });
    expect(out).toBe("const a = 1;\n16 const b = 2;\n17 const c = 3;");
    expect(out.split("\n")[0]).toBe("const a = 1;");
  });
});
