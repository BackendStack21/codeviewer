import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { files, makeServer, type Fx } from "./helpers/searchsrv.ts";

let fx: Fx;
beforeAll(async () => {
  fx = await makeServer(async (dir) => {
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs", "README.md"), "a needle here\n");
    // Listed before docs/README.md (breadth first): the match must still be reported under the real file.
    await symlink(path.join(dir, "docs", "README.md"), path.join(dir, "README.md"));
    await writeFile(path.join(dir, "solo.txt"), "needle\n");
    await symlink(path.join(dir, "solo.txt"), path.join(dir, "alias.txt"));
  });
});
afterAll(async () => {
  await fx.stop();
});

test("a match in a symlinked file is reported once, under the real path", async () => {
  const r = await fx.search({ q: "needle" });
  const paths = files(r.events).map((f) => f.path).sort();
  expect(paths).toEqual(["docs/README.md", "solo.txt"]);
});

test("a symlink whose target is excluded by the globs is still searched, under its own name", async () => {
  const r = await fx.search({ q: "needle", exclude: "docs/" });
  expect(files(r.events).map((f) => f.path).sort()).toEqual(["README.md", "solo.txt"]);
});
