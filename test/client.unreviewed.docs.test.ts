import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { installDom, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

const read = (f: string) => readFileSync(`${import.meta.dir}/../${f}`, "utf8");

describe("help sheet", () => {
  let rows: { label: string; key: string }[];
  beforeAll(async () => {
    installDom({ platform: "Linux x86_64" });
    const { Help } = await import("../src/client/help.ts");
    const help = new Help();
    rows = help.el.querySelectorAll<FakeElement>(".kb-row").map((r) => ({
      label: r.querySelector("span")!.textContent,
      key: r.querySelector("kbd")!.textContent,
    }));
  });
  afterAll(() => uninstallDom());

  test("lists the unreviewed keys right after the Alt+F5 row, in the module's platform labels", async () => {
    const { key } = await import("../src/client/util.ts");
    const i = rows.findIndex((r) => /unreviewed/i.test(r.label));
    expect(i).toBeGreaterThan(0);
    expect(rows[i]!.label).toBe("Next / previous unreviewed changed file");
    expect(rows[i]!.key).toBe(key("⌥F6 · ⌥⇧F6", "Alt+F6 · Alt+Shift+F6"));
    expect(rows[i - 1]!.key).toBe(key("⌥F5 · ⌥⇧F5", "Alt+F5 · Alt+Shift+F5"));
  });

  test("the source carries both platform spellings", () => {
    expect(read("src/client/help.ts")).toContain('key("⌥F6 · ⌥⇧F6", "Alt+F6 · Alt+Shift+F6")');
  });
});

describe("README", () => {
  const readme = read("README.md");
  test("key table row", () => {
    const table = readme.split("\n").filter((l) => l.startsWith("|"));
    expect(table.some((l) => l.includes("⌥F6 / ⌥⇧F6") && /unreviewed/i.test(l))).toBe(true);
  });
  test("Review changes bullet explains stepping and the spoken state", () => {
    const i = readme.indexOf("**Review changes");
    expect(i).toBeGreaterThan(-1);
    const j = readme.indexOf("**Risk flags:**", i);
    const bullet = readme.slice(i, j);
    expect(bullet).toContain("⌥F6 / ⌥⇧F6");
    expect(bullet).toMatch(/not yet reviewed|unreviewed/i);
    expect(bullet).toMatch(/screen reader/i);
    expect(bullet).toContain("reviewed");
  });
});

describe("AGENTS.md", () => {
  test("layout table has a row for unreviewed.ts", () => {
    const row = read("AGENTS.md").split("\n").find((l) => l.startsWith("|") && l.includes("src/client/unreviewed.ts"));
    expect(row).toBeDefined();
    expect(row).toContain("runUnreviewed");
    expect(row).toMatch(/live region|announce/i);
    expect(row).toContain("app.ts");
  });
});
