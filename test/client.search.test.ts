import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let S: typeof import("../src/client/search.ts");
let A: typeof import("../src/client/api.ts");
beforeAll(async () => {
  installDom();
  // Loaded dynamically so a missing module fails the tests by assertion, not by a load error.
  try {
    A = await import("../src/client/api.ts");
  } catch {}
  try {
    S = await import("../src/client/search.ts");
  } catch {}
});
afterAll(() => uninstallDom());

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resolves with the value, or rejects after ms so a hang fails instead of timing out the suite. */
const within = <T>(p: Promise<T>, ms = 1500): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);

type M = { line: number; col: number; len: number; preview: string; pcol: number };
const m = (line: number, preview: string, pcol: number, len: number, col = pcol): M => ({ line, col, len, preview, pcol });
const file = (path: string, matches: M[], more?: number) => ({ t: "file" as const, path, matches, ...(more ? { more } : {}) });
const done = (o: Partial<{ files: number; matches: number; skipped: number; truncated: false | "matches" | "time" }> = {}) => ({
  t: "done" as const,
  files: 0,
  matches: 0,
  skipped: 0,
  truncated: false as const,
  ms: 1,
  ...o,
});
const nd = (...evs: unknown[]) => evs.map((e) => JSON.stringify(e) + "\n").join("");

/** A controllable NDJSON response body. */
function stream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctl = c) });
  return {
    response: () => new Response(body, { headers: { "content-type": "application/x-ndjson" } }),
    push: (s: string) => ctl.enqueue(enc.encode(s)),
    close: () => ctl.close(),
  };
}

describe("ndjsonLines", () => {
  beforeEach(() => {
    expect(typeof A?.ndjsonLines).toBe("function");
  });
  test("complete lines are returned and the unfinished tail is carried", () => {
    expect(A.ndjsonLines("", '{"a":1}\n{"b":')).toEqual({ lines: ['{"a":1}'], rest: '{"b":' });
    expect(A.ndjsonLines('{"b":', "2}\n")).toEqual({ lines: ['{"b":2}'], rest: "" });
  });
  test("a chunk with several lines, blank lines dropped, CRLF tolerated", () => {
    expect(A.ndjsonLines("", "x\n\ny\r\nz")).toEqual({ lines: ["x", "y"], rest: "z" });
  });
  test("no newline means everything is carried", () => {
    expect(A.ndjsonLines("ab", "cd")).toEqual({ lines: [], rest: "abcd" });
  });
  test("splitting a stream at every possible boundary yields the same lines", () => {
    const text = '{"t":"file","path":"é/日本.ts"}\n{"t":"done"}\n';
    for (let i = 0; i <= text.length; i++) {
      const a = A.ndjsonLines("", text.slice(0, i));
      const b = A.ndjsonLines(a.rest, text.slice(i));
      expect([...a.lines, ...b.lines]).toEqual(['{"t":"file","path":"é/日本.ts"}', '{"t":"done"}']);
      expect(b.rest).toBe("");
    }
  });
});

describe("api.search", () => {
  beforeEach(() => {
    expect(typeof A?.api?.search).toBe("function");
  });
  let restore = () => {};
  afterEach(() => restore());
  const use = (h: Parameters<typeof mockFetch>[0]) => {
    const r = mockFetch(h);
    restore = r.restore;
    return r.calls;
  };
  const collect = async (it: AsyncIterable<unknown>) => {
    const out: unknown[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  test("builds the query string from the set options only", async () => {
    const calls = use(() => new Response(nd(done())));
    await collect(A.api.search({ q: "a b&c" }));
    expect(calls.length).toBe(1);
    const u1 = new URL(calls[0]!.url, "http://x");
    expect(u1.pathname).toBe("/api/search");
    expect(u1.searchParams.get("q")).toBe("a b&c");
    for (const k of ["case", "word", "regex", "include", "exclude", "ignored"]) expect(u1.searchParams.has(k)).toBe(false);

    await collect(A.api.search({ q: "x", case: true, word: true, regex: true, include: "src/**,*.ts", exclude: "dist", ignored: true }));
    const u2 = new URL(calls[1]!.url, "http://x").searchParams;
    expect(u2.get("q")).toBe("x");
    for (const k of ["case", "word", "regex", "ignored"]) expect(u2.get(k)).toBe("1");
    expect(u2.get("include")).toBe("src/**,*.ts");
    expect(u2.get("exclude")).toBe("dist");
    expect(calls[1]!.url.startsWith("/api/search?")).toBe(true); // relative, so the auth fetch wrapper adds x-cv-token
  });

  test("passes the AbortSignal to fetch", async () => {
    const calls = use(() => new Response(nd(done())));
    const ac = new AbortController();
    await collect(A.api.search({ q: "x" }, ac.signal));
    expect(calls.length).toBe(1);
    expect(calls[0]!.init?.signal).toBe(ac.signal);
  });

  test("yields events in order across arbitrary chunk boundaries and ignores malformed lines", async () => {
    const f1 = file("a.ts", [m(1, "hello", 0, 5)]);
    const f2 = file("b.ts", [m(2, "world", 0, 5)]);
    const text = nd(f1) + "this is not json\n" + '{"t":"mystery"}\n' + nd(f2, done({ files: 2, matches: 2 }));
    const bytes = enc.encode(text);
    const calls = use(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); // splits mid-line and mid-UTF-8 not needed: ASCII
          c.close();
        },
      });
      return new Response(body);
    });
    const evs = await within(collect(A.api.search({ q: "x" })));
    expect(calls.length).toBe(1);
    expect(evs).toEqual([f1, f2, done({ files: 2, matches: 2 })]);
  });

  test("multi-byte characters split across chunks are decoded intact", async () => {
    const f1 = file("日本/é.ts", [m(1, "日本語", 0, 3)]);
    const bytes = enc.encode(nd(f1, done()));
    use(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 1) c.enqueue(bytes.slice(i, i + 1));
          c.close();
        },
      });
      return new Response(body);
    });
    expect(await within(collect(A.api.search({ q: "x" })))).toEqual([f1, done()]);
  });

  test("a final line without a trailing newline is still parsed", async () => {
    use(() => new Response(JSON.stringify(done({ files: 1 }))));
    expect(await collect(A.api.search({ q: "x" }))).toEqual([done({ files: 1 })]);
  });

  test("an error response throws the server's message", async () => {
    use(() => Response.json({ error: "Invalid regular expression" }, { status: 400 }));
    await expect(collect(A.api.search({ q: "(" , regex: true }))).rejects.toThrow("Invalid regular expression");
    use(() => new Response("nope", { status: 500, statusText: "Boom" }));
    await expect(collect(A.api.search({ q: "x" }))).rejects.toThrow("Boom");
  });

  test("aborting ends the iteration without throwing", async () => {
    const s = stream();
    use(() => s.response());
    const ac = new AbortController();
    const got: unknown[] = [];
    const run = (async () => {
      for await (const e of A.api.search({ q: "x" }, ac.signal)) {
        got.push(e);
        ac.abort();
      }
    })();
    s.push(nd(file("a.ts", [m(1, "x", 0, 1)])));
    await within(run);
    expect(got.length).toBe(1);
  });
});

describe("SearchView", () => {
  beforeEach(() => {
    expect(S?.SearchView).toBeDefined();
  });
  let restore = () => {};
  afterEach(() => restore());

  const make = (handler: Parameters<typeof mockFetch>[0], debounce = 0) => {
    const r = mockFetch(handler);
    restore = r.restore;
    const v = new S.SearchView({ debounce });
    const must = (sel: string): FakeElement => {
      const e = (v.el as unknown as FakeElement).querySelector(sel);
      expect(e).not.toBeNull();
      return e!;
    };
    const input = must(".sv-query");
    const include = must(".sv-include");
    const exclude = must(".sv-exclude");
    const results = must(".sv-results");
    const progress = must(".sv-progress");
    const toggle = (opt: string) => {
      const t = (v.el as unknown as FakeElement).querySelectorAll(".sv-toggle").find((e) => e.dataset.opt === opt);
      expect(t).toBeDefined();
      return t!;
    };
    const type = (s: string, el = input) => {
      el.value = s;
      el.dispatchEvent(new FakeEvent("input"));
    };
    const enter = () => input.dispatchEvent(new FakeEvent("keydown", { key: "Enter" }));
    const click = (el: FakeElement) => el.dispatchEvent(new FakeEvent("click"));
    /** A click whose target is a result element, as the browser would report it. */
    const clickRow = (kind: "sv-row" | "sv-file", attr: "i" | "f", n: number) =>
      results.dispatchEvent(
        new FakeEvent("click", {
          target: { closest: (sel: string) => (sel.includes(kind) ? { dataset: { [attr]: String(n) } } : null) },
        }),
      );
    const params = (i: number) => new URL(r.calls[i]!.url, "http://x").searchParams;
    const flush = async () => {
      for (let i = 0; i < 5; i++) await sleep(0);
    };
    return { v, r, input, include, exclude, results, progress, toggle, type, enter, click, clickRow, params, flush };
  };

  const quick = (...evs: unknown[]) => () => new Response(nd(...evs));

  test("starts with the empty-query hint, no progress and pressed=false toggles", () => {
    const t = make(quick(done()));
    expect(t.results.innerHTML).toContain("Type to search");
    expect(t.progress.hidden).toBe(true);
    expect(t.r.calls.length).toBe(0);
  });

  // AC-24
  test("toggle buttons carry the find-bar labels and aria-pressed state", () => {
    const t = make(quick(done()));
    expect(t.toggle("case").textContent).toBe("Aa");
    expect(t.toggle("word").textContent).toBe("ab");
    expect(t.toggle("regex").textContent).toBe(".*");
    expect(t.toggle("ignored").textContent).toContain("Include ignored files");
    for (const o of ["case", "word", "regex", "ignored"]) expect(t.toggle(o).getAttribute("aria-pressed")).toBe("false");
    t.click(t.toggle("case"));
    expect(t.toggle("case").getAttribute("aria-pressed")).toBe("true");
    expect(t.toggle("word").getAttribute("aria-pressed")).toBe("false");
    t.click(t.toggle("case"));
    expect(t.toggle("case").getAttribute("aria-pressed")).toBe("false");
  });

  test("the request carries the options, and changing any option re-runs the search", async () => {
    const t = make(quick(done()));
    t.type("needle");
    await t.flush();
    expect(t.r.calls.length).toBe(1);
    expect(t.params(0).get("q")).toBe("needle");
    expect(t.params(0).has("case")).toBe(false);

    t.click(t.toggle("case"));
    await t.flush();
    t.click(t.toggle("word"));
    await t.flush();
    t.click(t.toggle("regex"));
    await t.flush();
    t.click(t.toggle("ignored"));
    await t.flush();
    t.type("src/**, *.ts", t.include);
    await t.flush();
    t.type("dist", t.exclude);
    await t.flush();
    expect(t.r.calls.length).toBe(7);
    const p = t.params(6);
    expect(p.get("q")).toBe("needle");
    for (const k of ["case", "word", "regex", "ignored"]) expect(p.get(k)).toBe("1");
    expect(p.get("include")).toBe("src/**, *.ts");
    expect(p.get("exclude")).toBe("dist");

    t.click(t.toggle("case")); // switching off drops the param again
    await t.flush();
    expect(t.params(7).has("case")).toBe(false);
  });

  test("changing an option with an empty query does not search", async () => {
    const t = make(quick(done()));
    t.click(t.toggle("case"));
    t.type("src", t.include);
    await t.flush();
    expect(t.r.calls.length).toBe(0);
  });

  // AC-15
  test("results are grouped by file with per-file counts, summary and collapsible headers", async () => {
    const t = make(quick(file("src/a.ts", [m(3, "foo bar", 0, 3), m(9, "a foo", 2, 3)]), file("lib/b.ts", [m(1, "foo", 0, 3)], 4), done({ files: 2, matches: 7 })));
    t.type("foo");
    await t.flush();
    const html = t.results.innerHTML;
    expect(html).toContain("7 results in 2 files");
    const heads = [...html.matchAll(/<div class="sv-file[^"]*" data-f="(\d+)"[^>]*>(.*?)<\/div>/g)];
    expect(heads.length).toBe(2);
    expect(heads[0]![2]).toContain("a.ts");
    expect(heads[0]![2]).toMatch(/>2</); // count of the first file
    expect(heads[1]![2]).toContain("b.ts");
    expect(heads[1]![2]).toMatch(/>5</); // 1 shown + 4 more
    expect([...html.matchAll(/class="sv-row" data-i="(\d+)"/g)].map((r) => +r[1]!)).toEqual([0, 1, 2]);
    expect(html).toContain("<mark>foo</mark>");
    expect(html).toContain(">3<"); // line number

    t.clickRow("sv-file", "f", 0); // collapse the first file
    const c = t.results.innerHTML;
    expect(c).toContain("a.ts");
    expect([...c.matchAll(/class="sv-row" data-i="(\d+)"/g)].map((r) => +r[1]!)).toEqual([2]); // data-i stays stable
    t.clickRow("sv-file", "f", 0);
    expect([...t.results.innerHTML.matchAll(/class="sv-row" data-i="(\d+)"/g)].length).toBe(3);
  });

  test("singular summary wording", async () => {
    const t = make(quick(file("a.ts", [m(1, "x", 0, 1)]), done({ files: 1, matches: 1 })));
    t.type("x", t.input);
    t.enter();
    await t.flush();
    expect(t.results.innerHTML).toContain("1 result in 1 file");
  });

  test("clicking a row opens the file at line, col and length", async () => {
    const t = make(quick(file("src/a.ts", [m(3, "foo", 0, 3)]), file("lib/b.ts", [m(12, "xx foo", 3, 3, 40)]), done({ files: 2, matches: 2 })));
    const got: unknown[][] = [];
    t.v.onOpen = (...a) => got.push(a);
    t.type("foo");
    await t.flush();
    t.clickRow("sv-row", "i", 1);
    t.clickRow("sv-row", "i", 0);
    expect(got).toEqual([
      ["lib/b.ts", 12, 40, 3],
      ["src/a.ts", 3, 0, 3],
    ]);
    t.clickRow("sv-row", "i", 99); // unknown index: ignored
    expect(got.length).toBe(2);
  });

  test("truncation banner, skipped note and timeout note", async () => {
    let t = make(quick(file("a.ts", [m(1, "x", 0, 1)]), done({ files: 1, matches: 2000, skipped: 3, truncated: "matches" })));
    t.type("xx");
    await t.flush();
    expect(t.results.innerHTML).toContain("Showing first 2,000 results");
    expect(t.results.innerHTML).toContain("3 binary/large files skipped");
    restore();

    t = make(quick(file("a.ts", [m(1, "x", 0, 1)]), done({ files: 1, matches: 1, skipped: 1, truncated: "time" })));
    t.type("xx");
    await t.flush();
    expect(t.results.innerHTML).not.toContain("Showing first 2,000");
    expect(t.results.innerHTML).toMatch(/timed out|time limit/i);
    expect(t.results.innerHTML).toContain("1 binary/large file skipped");
    restore();

    t = make(quick(file("a.ts", [m(1, "x", 0, 1)]), done({ files: 1, matches: 1 })));
    t.type("xx");
    await t.flush();
    expect(t.results.innerHTML).not.toContain("skipped");
    expect(t.results.innerHTML).not.toContain("Showing first");
  });

  // AC-17
  test("no results message escapes the query", async () => {
    const t = make(quick(done()));
    t.type("<b>zz</b>");
    await t.flush();
    expect(t.results.innerHTML).toContain("No results for");
    expect(t.results.innerHTML).toContain("&lt;b&gt;zz&lt;/b&gt;");
    expect(t.results.innerHTML).not.toContain("<b>zz");
  });

  test("an invalid-regex response shows the server message and marks the input", async () => {
    const t = make(() => Response.json({ error: "Invalid regular expression" }, { status: 400 }));
    t.click(t.toggle("regex"));
    t.type("(");
    await t.flush();
    expect(t.results.innerHTML).toContain("Invalid regular expression");
    expect(t.input.classList.contains("invalid")).toBe(true);
    expect(t.progress.hidden).toBe(true);
    t.r.restore();
    restore = mockFetch(quick(done())).restore;
    t.type("()");
    await t.flush();
    expect(t.input.classList.contains("invalid")).toBe(false);
  });

  test("a network failure shows a generic error, never a stack", async () => {
    const t = make(() => {
      throw new TypeError("fetch failed at /Users/me/secret");
    });
    t.type("abc");
    await t.flush();
    expect(t.results.innerHTML).toContain("Search failed");
    expect(t.results.innerHTML).not.toContain("/Users/me");
  });

  test("live search needs 2 chars (1 with regex); Enter searches right away", async () => {
    const t = make(quick(done()));
    t.type("a");
    await t.flush();
    expect(t.r.calls.length).toBe(0);
    expect(t.results.innerHTML).toContain("Type to search");
    t.enter(); // explicit: even one character
    await t.flush();
    expect(t.r.calls.length).toBe(1);
    t.type("");
    await t.flush();
    expect(t.r.calls.length).toBe(1);
    expect(t.results.innerHTML).toContain("Type to search");
    t.enter(); // empty query: nothing to do
    expect(t.r.calls.length).toBe(1);
    t.click(t.toggle("regex"));
    t.type("b");
    await t.flush();
    expect(t.r.calls.length).toBe(2);
  });

  test("typing is debounced; Enter cancels the wait and runs now", async () => {
    const t = make(quick(done()), 60);
    t.type("ab");
    t.type("abc");
    t.type("abcd");
    await sleep(20);
    expect(t.r.calls.length).toBe(0);
    await sleep(120);
    expect(t.r.calls.length).toBe(1);
    expect(t.params(0).get("q")).toBe("abcd");

    t.type("abcde");
    t.enter();
    await t.flush();
    expect(t.r.calls.length).toBe(2);
    await sleep(120);
    expect(t.r.calls.length).toBe(2); // the pending debounce was cancelled
  });

  test("the progress bar appears only if the search is still running after 150 ms", async () => {
    const s = stream();
    const t = make(() => s.response());
    t.type("abc");
    await sleep(50);
    expect(t.progress.hidden).toBe(true);
    await sleep(160);
    expect(t.progress.hidden).toBe(false);
    s.push(nd(done({ files: 0 })));
    s.close();
    await t.flush();
    expect(t.progress.hidden).toBe(true);

    // a fast search never shows it
    t.r.restore();
    const t2 = make(quick(done()));
    t2.type("abc");
    await sleep(200);
    expect(t2.progress.hidden).toBe(true);
  });

  test("results appear while the stream is still open", async () => {
    const s = stream();
    const t = make(() => s.response());
    t.type("abc");
    await t.flush();
    s.push(nd(file("a.ts", [m(1, "abc", 0, 3)])));
    await t.flush();
    expect(t.results.innerHTML).toContain("a.ts");
    s.push(nd(done({ files: 1, matches: 1 })));
    s.close();
    await t.flush();
    expect(t.results.innerHTML).toContain("1 result in 1 file");
  });

  test("a new search aborts the previous request and late events from it are ignored", async () => {
    const first = stream();
    const second = stream();
    const bodies = [first, second];
    const t = make(() => bodies.shift()!.response());
    t.type("old");
    await t.flush();
    const sig1 = t.r.calls[0]!.init?.signal as AbortSignal;
    expect(sig1.aborted).toBe(false);
    t.type("new");
    await t.flush();
    expect(sig1.aborted).toBe(true);
    expect((t.r.calls[1]!.init?.signal as AbortSignal).aborted).toBe(false);

    second.push(nd(file("new.ts", [m(1, "new", 0, 3)]), done({ files: 1, matches: 1 })));
    second.close();
    await t.flush();
    first.push(nd(file("old.ts", [m(1, "old", 0, 3)]), done({ files: 1, matches: 1, truncated: "matches" })));
    first.close();
    await t.flush();
    const html = t.results.innerHTML;
    expect(html).toContain("new.ts");
    expect(html).not.toContain("old.ts");
    expect(html).not.toContain("Showing first");
    expect(t.progress.hidden).toBe(true);
  });

  test("a late failure of an aborted search does not show an error", async () => {
    const first = stream();
    const bodies = [first.response.bind(first), () => new Response(nd(done({ files: 0 })))];
    const t = make(() => bodies.shift()!());
    t.type("old");
    await t.flush();
    t.type("new");
    await t.flush();
    first.push("{garbage");
    first.close();
    await t.flush();
    expect(t.results.innerHTML).not.toContain("Search failed");
    expect(t.results.innerHTML).toContain("No results for");
    expect(t.results.innerHTML).toContain("new");
  });

  test("clearing the query aborts the running search and restores the hint", async () => {
    const s = stream();
    const t = make(() => s.response());
    t.type("abc");
    await t.flush();
    const sig = t.r.calls[0]!.init?.signal as AbortSignal;
    t.type("");
    await t.flush();
    expect(sig.aborted).toBe(true);
    expect(t.results.innerHTML).toContain("Type to search");
    expect(t.progress.hidden).toBe(true);
  });

  // AC-16
  test("hostile paths and previews are escaped, only the match is marked, no path in attributes", async () => {
    const evilPath = `<img src=x onerror=alert(1)>/"q"&.ts`;
    const t = make(
      quick(
        file(evilPath, [m(1, `<script>alert("x")</script>`, 8, 5)]),
        done({ files: 1, matches: 1 }),
      ),
    );
    t.type("alert");
    await t.flush();
    const html = t.results.innerHTML;
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;<mark>alert</mark>(&quot;x&quot;)&lt;/script&gt;");
    expect([...html.matchAll(/<mark>/g)].length).toBe(1);
    // no tag carries any piece of the path or the preview in an attribute
    for (const tag of html.matchAll(/<[a-z][^>]*>/gi)) {
      expect(tag[0]).not.toContain("onerror");
      expect(tag[0]).not.toContain(".ts");
      expect(tag[0]).not.toContain("alert");
    }
    expect(html).toContain('data-i="0"');
  });

  test("control characters and bidi overrides are shown as visible escapes", async () => {
    const bidi = "‮⁦⁩‪";
    const t = make(
      quick(
        file(`dir‮fdp.ts`, [m(1, `a\u0001b\u001bc\u009fd${bidi}e`, 0, 1)]),
        done({ files: 1, matches: 1 }),
      ),
    );
    t.type("a");
    t.enter();
    await t.flush();
    const html = t.results.innerHTML;
    for (const raw of ["\u0001", "\u001b", "\u009f", "‮", "⁦", "⁩", "‪"]) expect(html).not.toContain(raw);
    expect(html).toContain("\\x01");
    expect(html).toContain("\\x1b");
    expect(html).toContain("\\x9f");
    expect(html).toContain("\\u202e");
    expect(html).toContain("\\u2066");
    expect(html).toContain("\\u2069");
    expect(html).toContain("\\u202a");
    expect(html.match(/\\u202e/g)!.length).toBe(2); // in the path and in the preview
  });

  test("a control character inside the match stays inside the mark", async () => {
    const t = make(quick(file("a.ts", [m(1, "x\u0007y", 1, 1)]), done({ files: 1, matches: 1 })));
    t.type("x");
    t.enter();
    await t.flush();
    expect(t.results.innerHTML).toContain("x<mark>\\x07</mark>y");
  });
});
