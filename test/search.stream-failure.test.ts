import { afterAll, describe, expect, test } from "bun:test";
import { done, makeServer, type Fx } from "./helpers/searchsrv.ts";

const fixtures: Fx[] = [];
afterAll(async () => {
  for (const f of fixtures) await f.stop();
});

const failAfterOutput = async (secret: (dir: string) => string) => {
  let dir = "";
  const f = await makeServer(async () => {}, {
    searchScanner: async (req, _signal, emit) => {
      dir = req.root;
      emit({ t: "file", path: "a.txt", matches: [{ line: 1, col: 0, len: 6, preview: "needle", pcol: 0 }] });
      throw new Error(secret(req.root));
    },
  });
  fixtures.push(f);
  const r = await f.search({ q: "needle" }, 5000);
  return { r, dir: () => dir, f };
};

describe("scanner failure after output started (SL02 R-01)", () => {
  test("the NDJSON stream still ends with exactly one final done line carrying a fixed failure marker", async () => {
    const { r } = await failAfterOutput((d) => `EACCES: open '${d}/secret/id_rsa'`);
    expect(r.status).toBe(200);
    expect(r.events[0]!.t).toBe("file");
    expect(r.events.at(-1)!.t).toBe("done");
    expect(r.events.filter((e) => e.t === "done").length).toBe(1);
    const d = done(r.events)! as unknown as { truncated: unknown; error?: unknown; files: number; matches: number };
    // A fixed marker: either an error flag or a truncated value, never a message.
    expect(d.error === true || (d.truncated !== false && typeof d.truncated === "string")).toBe(true);
    expect(d.files).toBe(1);
    expect(d.matches).toBe(1);
  });

  test("no path or e.message reaches the client", async () => {
    const { r, dir } = await failAfterOutput((d) => `EACCES: open '${d}/secret/id_rsa'`);
    expect(dir()).not.toBe("");
    expect(r.text).not.toContain(dir());
    expect(r.text).not.toContain("EACCES");
    expect(r.text).not.toContain("id_rsa");
  });

  test("the server stays usable for the next search", async () => {
    const { f } = await failAfterOutput(() => "boom");
    const again = await f.search({ q: "needle" }, 5000);
    expect(again.events.at(-1)!.t).toBe("done");
  });
});
