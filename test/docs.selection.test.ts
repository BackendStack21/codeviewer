import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("AC-12 README selection note", () => {
  test("has a Selection section that talks about copying", () => {
    const lines = readme.split("\n");
    const at = lines.findIndex((l) => /^#{2,4}\s.*selection/i.test(l));
    expect(at).toBeGreaterThanOrEqual(0);
    let end = lines.findIndex((l, i) => i > at && /^#{1,4}\s/.test(l));
    if (end < 0) end = lines.length;
    const section = lines.slice(at, end).join("\n");
    expect(section).toMatch(/copy/i);
    expect(section.length).toBeGreaterThan(80);
  });

  test("mentions the truncation label and that select-all needs focus in the code view", () => {
    const lines = readme.split("\n");
    const at = lines.findIndex((l) => /^#{2,4}\s.*selection/i.test(l));
    let end = lines.findIndex((l, i) => i > at && /^#{1,4}\s/.test(l));
    if (end < 0) end = lines.length;
    const section = lines.slice(at, end).join("\n");
    expect(section).toMatch(/truncat/i);
    expect(section).toMatch(/focus/i);
  });

  test("does not mention copy as image", () => {
    expect(readme).not.toMatch(/copy as image/i);
  });
});
