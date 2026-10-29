import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { parseGlobs } from "../src/server/search.ts";
import { FakeEvent, installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let S: typeof import("../src/client/search.ts");
beforeAll(async () => {
  installDom();
  S = await import("../src/client/search.ts");
});
afterAll(() => uninstallDom());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const done = () => JSON.stringify({ t: "done", files: 0, matches: 0, skipped: 0, truncated: false, ms: 1 }) + "\n";

describe("folderGlob", () => {
  test("matches everything under the folder and nothing beside it", () => {
    const g = new Bun.Glob(S.folderGlob("src/client"));
    expect(g.match("src/client/a.ts")).toBe(true);
    expect(g.match("src/client/term/b.ts")).toBe(true);
    expect(g.match("src/server/a.ts")).toBe(false);
    expect(g.match("src/clientx/a.ts")).toBe(false);
  });

  test("glob metacharacters in folder names are literal", () => {
    for (const dir of ["a[b]", "a{x,y}", "a*b", "q?", "!neg", "back\\slash", "pages/[id]"]) {
      const g = new Bun.Glob(S.folderGlob(dir));
      expect(g.match(`${dir}/f.ts`)).toBe(true);
    }
    expect(new Bun.Glob(S.folderGlob("a*b")).match("aZb/f.ts")).toBe(false);
    expect(new Bun.Glob(S.folderGlob("pages/[id]")).match("pages/i/f.ts")).toBe(false);
  });

  test("a comma never splits the include list", () => {
    const g = S.folderGlob("a,b");
    expect(g).toBe("a\\,b/**");
    expect(parseGlobs(g)).toEqual(["a,b/**"]);
    const glob = new Bun.Glob(parseGlobs(g)[0]!);
    expect(glob.match("a,b/f.ts")).toBe(true);
    expect(glob.match("a_b/f.ts")).toBe(false);
  });
});

describe("SearchView.searchIn", () => {
  let restore = () => {};
  afterEach(() => restore());

  const make = () => {
    const r = mockFetch(() => new Response(done()));
    restore = r.restore;
    const v = new S.SearchView({ debounce: 0 });
    const root = v.el as unknown as FakeElement;
    return { v, calls: r.calls, input: root.querySelector(".sv-query")!, include: root.querySelector(".sv-include")! };
  };

  test("sets the include field and focuses the query without searching when it is empty", async () => {
    const { v, calls, input, include } = make();
    v.searchIn("src/client");
    await sleep(0);
    expect(include.value).toBe("src/client/**");
    expect(input.focused).toBe(true);
    expect(calls.length).toBe(0);
  });

  test("re-runs a current query scoped to the folder", async () => {
    const { v, calls, input } = make();
    input.value = "foo";
    input.dispatchEvent(new FakeEvent("input"));
    await sleep(0);
    v.searchIn("lib");
    await sleep(0);
    const url = new URL(calls.at(-1)!.url, "http://x");
    expect(url.searchParams.get("q")).toBe("foo");
    expect(url.searchParams.get("include")).toBe("lib/**");
  });
});
