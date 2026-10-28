import { expect, test } from "bun:test";
import { GitState } from "../src/client/git.ts";

/** Timing budgets are tuned on a laptop; shared CI runners get 4× headroom. */
const BUDGET = process.env.CI ? 4 : 1;

const base = { repo: true, branch: "main", detached: false, oid: null, upstream: null, ahead: 0, behind: 0, state: null, stash: 0, head: null };

test("letters, folder roll-up, untracked/ignored folders and NFC/NFD names", () => {
  const g = new GitState();
  g.set({ ...base, files: { "src/a.ts": ".M", "src/new.ts": "A.", "src/both.ts": "AM", "docs/": "??", "build/": "!!", "café.txt": ".M", "x.ts": "UU" } });
  expect(g.file("src/a.ts")?.letter).toBe("M");
  expect(g.file("src/new.ts")?.letter).toBe("A");
  expect(g.file("src/both.ts")?.xy).toBe("AM");
  expect(g.file("docs/deep/inner.md")?.letter).toBe("U");
  expect(g.file("build/out/x.js")?.letter).toBe("I");
  expect(g.dir("build")).toBe("I");
  expect(g.dir("docs/deep")).toBe("U");
  expect(g.dir("src")).toBe("M");
  expect(g.file("café.txt")?.letter).toBe("M"); // NFD name from macOS readdir
  expect(g.file("x.ts")?.letter).toBe("C");
  expect(g.counts).toEqual({ changed: 3 + 1, staged: 2, untracked: 1, conflicts: 1 });
});

test("lookups stay fast with thousands of ignored folders", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 20_000; i++) files[`pkg${i}/__pycache__/`] = "!!";
  const g = new GitState();
  g.set({ ...base, files });
  const t = performance.now();
  for (let i = 0; i < 6000; i++) g.file(`pkg${i % 500}/src/module${i}.py`);
  expect(performance.now() - t).toBeLessThan(50 * BUDGET);
});
