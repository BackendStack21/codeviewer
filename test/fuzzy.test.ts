import { expect, test } from "bun:test";
import { scorePath } from "../src/client/palette.ts";

test("fuzzy ranking prefers basename and word-start matches", () => {
  const files = ["src/client/term/terminal.ts", "src/client/terminals.ts", "test/terminal.test.ts", "docs/termination-notes.md"];
  const rank = (q: string) =>
    files
      .map((f) => ({ f, m: scorePath(q, f) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .map((x) => x.f);
  expect(rank("terminals")[0]).toBe("src/client/terminals.ts");
  expect(rank("termtest")[0]).toBe("test/terminal.test.ts");
  expect(rank("zzz")).toEqual([]);
});

import { searchPaths } from "../src/client/palette.ts";

/** Timing budgets are tuned on a laptop; shared CI runners get 4× headroom. */
const BUDGET = process.env.CI ? 4 : 1;
test("searchPaths: same top results as a full sort, narrowing on longer queries, fast on 200k paths", () => {
  const files = Array.from({ length: 200_000 }, (_, i) => `src/pkg${i % 997}/module_${i}/file${i}.ts`);
  files.push("src/server/index.ts", "src/client/term/terminal.ts");
  const lower = files.map((p) => p.toLowerCase());
  let t = performance.now();
  const a = searchPaths("ser", files, lower, null);
  const first = performance.now() - t;
  t = performance.now();
  const b = searchPaths("serind", files, lower, a.hits);
  const narrowed = performance.now() - t;
  expect(b.best[0]!.p).toBe("src/server/index.ts");
  expect(narrowed).toBeLessThan(first);
  expect(first).toBeLessThan(150 * BUDGET);
  // Narrowing must give the same answer as scoring everything.
  const full = searchPaths("serind", files, lower, null);
  expect(full.best.map((x) => x.p)).toEqual(b.best.map((x) => x.p));
});
