import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { filterByGlobs, parseGlobs } from "../src/server/search.ts";
import { FakeEvent, installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let S: typeof import("../src/client/search.ts");
beforeAll(async () => {
  installDom();
  S = await import("../src/client/search.ts");
});
afterAll(() => uninstallDom());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const done = () => JSON.stringify({ t: "done", files: 0, matches: 0, skipped: 0, truncated: false, ms: 1 }) + "\n";

/** What the server would use for an include value sent by the client: client trim, then parseGlobs. */
const serverGlobs = (include: string) => parseGlobs(include.trim());

describe("folder scope round trip (client folderGlob -> server parseGlobs)", () => {
  test("an escaped comma is not a separator and is unescaped for Bun.Glob", () => {
    expect(parseGlobs("a\\,b/**,c/**")).toEqual(["a,b/**", "c/**"]);
    expect(parseGlobs("a\\,b")).toEqual(["a,b"]);
    expect(parseGlobs("x\\\\,y")).toEqual(["x\\\\", "y"]); // escaped backslash, then a real separator
  });

  test("a comma in the folder name scopes literally, not to siblings", () => {
    const files = ["a,b/f.ts", "a_b/f.ts", "a-b/f.ts", "a,b/deep/g.ts"];
    expect(filterByGlobs(files, serverGlobs(S.folderGlob("a,b")), [])).toEqual(["a,b/f.ts", "a,b/deep/g.ts"]);
  });

  test("commas next to backslashes and at the edges stay literal", () => {
    for (const dir of ["a\\,b", ",lead", "trail,", "x,,y", "p/q,r/s"]) {
      const files = [`${dir}/f.ts`, `${dir.replace(/,/g, "_")}/f.ts`, `${dir}x/f.ts`];
      expect(filterByGlobs(files, serverGlobs(S.folderGlob(dir)), [])).toEqual([`${dir}/f.ts`]);
    }
  });

  test("leading and trailing whitespace in folder names survives trimming", () => {
    for (const dir of [" a", "a ", "\ta", "a\t", " a", " a /b ", "x/ y", "x/y "]) {
      const files = [...new Set([`${dir}/f.ts`, `${dir.trim()}/f.ts`])];
      const globs = serverGlobs(S.folderGlob(dir));
      expect(globs.length).toBe(1);
      expect(filterByGlobs(files, globs, [])).toEqual([`${dir}/f.ts`]);
    }
  });
});

describe("SearchView.searchIn requests", () => {
  let restore = () => {};
  afterEach(() => restore());

  const make = (handler?: (url: string) => Response) => {
    const r = mockFetch((url) => handler?.(url) ?? new Response(done()));
    restore = r.restore;
    const v = new S.SearchView({ debounce: 0 });
    const root = v.el as unknown as FakeElement;
    const input = root.querySelector(".sv-query")!;
    const type = async (q: string) => {
      input.value = q;
      input.dispatchEvent(new FakeEvent("input"));
      await sleep(0);
    };
    return { v, root, calls: r.calls, input, type, ignored: root.querySelector(".sv-wide")! };
  };
  const params = (url: string) => new URL(url, "http://x").searchParams;

  test("a git-ignored target folder turns 'Include ignored files' on and the search sends ignored=1", async () => {
    const { v, calls, type, ignored } = make();
    await type("foo");
    calls.length = 0;
    v.searchIn("dist", true);
    await sleep(0);
    expect(ignored.getAttribute("aria-pressed")).toBe("true");
    expect(calls.length).toBe(1);
    expect(params(calls[0]!.url).get("ignored")).toBe("1");
    expect(params(calls[0]!.url).get("include")).toBe("dist/**");
  });

  test("an ignored target also enables the toggle when no search runs yet", async () => {
    const { v, calls, ignored } = make();
    v.searchIn("build", true);
    await sleep(0);
    expect(ignored.getAttribute("aria-pressed")).toBe("true");
    expect(calls.length).toBe(0);
  });

  test("revealing the view cannot trigger a search with the old scope: exactly one scoped request", async () => {
    const { v, calls, type, input } = make();
    await type("foo");
    v.markStale(["x.ts"], true); // results went stale while the view was hidden
    calls.length = 0;
    const seen: string[] = [];
    let reveals = 0;
    v.onReveal = () => {
      reveals++;
      seen.push((v.el as unknown as FakeElement).querySelector(".sv-include")!.value);
      v.onShown(); // what App.showSearch -> setSideView("search") does
    };
    v.searchIn("lib");
    await sleep(0);
    expect(reveals).toBe(1);
    expect(seen).toEqual(["lib/**"]); // the scope is already set when the view is revealed
    expect(calls.length).toBe(1);
    expect(params(calls[0]!.url).get("include")).toBe("lib/**");
  });

  test("a scope too long for the server is reported without marking the query invalid", async () => {
    const tooLong = (url: string) =>
      (params(url).get("include") ?? "").length > 1024
        ? new Response(JSON.stringify({ error: "Invalid include/exclude globs" }), { status: 400 })
        : new Response(done());
    const { v, root, calls, input, type } = make(tooLong);
    await type("foo");
    v.searchIn(`${"d".repeat(200)}/`.repeat(6) + "x");
    await sleep(5);
    const results = root.querySelector(".sv-results")!;
    const sent = calls.filter((c) => (params(c.url).get("include") ?? "").length > 1024);
    expect(input.classList.contains("invalid")).toBe(false);
    expect(sent.length === 0 || /too long|folder/i.test(results.textContent)).toBe(true);
    expect(results.textContent).not.toContain("Invalid include/exclude globs");
  });
});
