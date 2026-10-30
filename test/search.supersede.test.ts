import { afterAll, expect, test } from "bun:test";
import { makeServer, type Fx } from "./helpers/searchsrv.ts";

const fixtures: Fx[] = [];
afterAll(async () => {
  for (const f of fixtures) await f.stop();
});

/** A scanner that emits one hit (unless q is "idle") and then waits to be cancelled, unless q is "fast". */
async function server() {
  const f = await makeServer(async () => {}, {
    searchScanner: async (req, signal, emit) => {
      if (req.q !== "idle") emit({ t: "file", path: "a.txt", matches: [{ line: 1, col: 0, len: 4, preview: "slow", pcol: 0 }] });
      if (req.q === "fast") return emit({ t: "done", files: 1, matches: 1, skipped: 0, truncated: false, ms: 1 });
      await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })));
    },
  });
  fixtures.push(f);
  return f;
}

test("a search cancelled by a newer one still ends its stream with a flagged done line", async () => {
  const f = await server();
  const first = f.search({ q: "slow" }, 5000);
  await Bun.sleep(150); // the first search has produced output
  const second = await f.search({ q: "fast" }, 5000);
  expect(second.events.at(-1)).toMatchObject({ t: "done", files: 1 });
  expect((second.events.at(-1) as { error?: unknown }).error).toBeUndefined();
  const r = await first;
  expect(r.status).toBe(200);
  expect(r.events[0]!.t).toBe("file");
  expect(r.events.filter((e) => e.t === "done").length).toBe(1);
  expect(r.events.at(-1)).toMatchObject({ t: "done", files: 1, matches: 1, skipped: 0, truncated: false, error: true });
  expect(typeof (r.events.at(-1) as { ms: unknown }).ms).toBe("number");
});

test("a superseded search that produced nothing yet ends cleanly, with no done line", async () => {
  const f = await server();
  const first = f.search({ q: "idle" }, 5000);
  await Bun.sleep(150);
  await f.search({ q: "fast" }, 5000);
  const r = await first;
  expect(r.status).toBe(200);
  expect(r.events).toEqual([]);
});

test("a client abort does not get a done line appended", async () => {
  const f = await server();
  const ac = new AbortController();
  const r = await f.raw({ q: "slow" }, { signal: ac.signal });
  const reader = r.body!.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain('"file"');
  ac.abort();
  await Bun.sleep(100);
  // The server is free for the next search.
  const again = await f.search({ q: "fast" }, 5000);
  expect(again.events.at(-1)!.t).toBe("done");
});
