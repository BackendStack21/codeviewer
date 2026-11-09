import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(`${import.meta.dir}/../${f}`, "utf8");
const readme = read("README.md");
const design = read("DESIGN.md");
const agents = read("AGENTS.md");

describe("checkpoint docs", () => {
  test("README documents the three commands near File History", () => {
    for (const t of ["Changes: Set Checkpoint", "Changes: Since Checkpoint…", "Changes: Clear Checkpoint"]) {
      expect(readme).toContain(t);
    }
    const hist = readme.indexOf("**File History:**");
    const set = readme.indexOf("Changes: Set Checkpoint");
    expect(hist).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(-1);
    expect(Math.abs(set - hist)).toBeLessThan(2500);
  });

  test("README states the limits: in memory, lost on reload, nothing written or sent, skips", () => {
    const i = readme.indexOf("Changes: Set Checkpoint");
    const para = readme.slice(Math.max(0, i - 200), i + 2500).toLowerCase();
    expect(para).toContain("in memory");
    expect(para).toContain("lost on reload");
    expect(para).toMatch(/nothing is (written|sent)/);
    expect(para).toContain("binary");
    expect(para).toContain("500 files");
    expect(para).toContain("16 million characters");
    expect(para).toContain("skipped");
  });

  test("README names the three commands more than once (feature list and palette)", () => {
    expect(readme.split("Changes: Set Checkpoint").length - 1).toBeGreaterThanOrEqual(1);
    expect(readme.split("Clear Checkpoint").length - 1).toBeGreaterThanOrEqual(2);
  });

  test("DESIGN.md section 30 follows section 29, which is untouched", () => {
    const h29 = design.indexOf("## 29. Round 20: hidden characters");
    const h30 = design.indexOf("## 30. Round 21: changes since a checkpoint\n");
    expect(h29).toBeGreaterThan(-1);
    expect(h30).toBeGreaterThan(h29);
    expect(design.slice(h29, h30)).toContain("Go to Next Hidden Character");
  });

  test("DESIGN.md section 30 has the votes, the design and the findings", () => {
    const s = design.slice(design.indexOf("## 30. Round 21: changes since a checkpoint"));
    expect(s).toContain("3 votes");
    expect(s).toContain("two first places");
    expect(s).toContain("Next/Previous Unreviewed Changed File");
    expect(s).toContain("Go to Definition");
    expect(s).toContain("fourth time");
    expect(s).toContain("client-only");
    expect(s).toContain("in memory");
    expect(s).toContain("checkpoint.ts");
    expect(s).toContain("checkpointctl.ts");
    expect(s).toContain("| Finding | Fix |");
    const rows = s.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Finding") && !l.startsWith("| ---"));
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const low = s.toLowerCase();
    expect(low).toContain("unchanged from the checkpoint");
    expect(low).toContain("reverts to its base text");
    expect(low).toContain("skipped and counted");
    expect(low).toContain("trailing-newline");
    expect(low).toContain("delete plus an add");
    expect(low).toContain("not tied to changes");
  });

  test("AGENTS.md layout row names both checkpoint modules", () => {
    const row = agents.split("\n").find((l) => l.startsWith("|") && l.includes("src/client/checkpoint.ts"));
    expect(row).toBeDefined();
    expect(row).toContain("src/client/checkpointctl.ts");
    expect(row).toMatch(/app\.ts/);
  });
});
