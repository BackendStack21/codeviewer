import { afterEach, describe, expect, test } from "bun:test";
import { api, ApiError, type ChangeFile } from "../src/client/api.ts";
import { checkpointText, CheckpointController, type CheckpointDeps, type SinceDiff } from "../src/client/checkpointctl.ts";
import type { PickItem } from "../src/client/palette.ts";

const ok = (text: string, over: Record<string, unknown> = {}) => async () => ({ kind: "text", truncated: false, text, ...over });
const fail = (e: unknown) => async (): Promise<{ kind: string; truncated: boolean; text: string }> => {
  throw e;
};

describe("AC-14 checkpointText returns text", () => {
  test("text and empty text", async () => {
    expect(await checkpointText(ok("hi"))).toBe("hi");
    expect(await checkpointText(ok(""))).toBe("");
  });
});

describe("AC-15 checkpointText failures", () => {
  test("binary, other kinds and truncated text are undefined", async () => {
    expect(await checkpointText(ok("x", { kind: "binary" }))).toBeUndefined();
    expect(await checkpointText(ok("x", { kind: "image" }))).toBeUndefined();
    expect(await checkpointText(ok("x", { truncated: true }))).toBeUndefined();
  });

  test("a 404 means the file vanished", async () => {
    expect(await checkpointText(fail(new ApiError("not found", 404)))).toBeNull();
    expect(await checkpointText(fail({ status: 404 }))).toBeNull();
  });

  test("any other failure is undefined", async () => {
    for (const status of [403, 413, 500]) expect(await checkpointText(fail(new ApiError("x", status)))).toBeUndefined();
    expect(await checkpointText(fail(new Error("boom")))).toBeUndefined();
    expect(await checkpointText(fail("nope"))).toBeUndefined();
    expect(await checkpointText(fail(null))).toBeUndefined();
  });

  test("ApiError is an Error with a status", () => {
    const e = new ApiError("x", 404);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("x");
    expect(e.status).toBe(404);
  });
});

describe("api.file throws an ApiError carrying the status", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  test("404 keeps its status and message", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })) as unknown as typeof fetch;
    const e = (await api.file("gone.ts").catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(404);
    expect(e.message).toBe("not found");
  });
  test("a body without an error falls back to the status text", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;
    const e = (await api.file("x.ts").catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(500);
    expect(e.message).toBe("Server Error");
  });
});

const file = (path: string, status: ChangeFile["status"] = "M"): ChangeFile => ({ path, status, added: null, removed: null, binary: false });

function make(files: () => ChangeFile[], fake: (p: string) => Promise<{ kind: string; truncated: boolean; text: string }>) {
  const toasts: string[] = [];
  const picked: PickItem[][] = [];
  const diffs: SinceDiff[] = [];
  const deps: CheckpointDeps = {
    changes: async () => ({ repo: true, rev: "R", files: files() }),
    readText: (p) => checkpointText(() => fake(p)),
    baseText: async () => undefined,
    now: () => 1,
    notify: (m) => void toasts.push(m),
    pick: (items) => void picked.push(items),
    openDiff: (d) => void diffs.push(d),
  };
  return { ctl: new CheckpointController(deps), toasts, picked, diffs };
}

describe("AC-16 a vanished file is recorded as deleted", () => {
  test("404 on b.ts: stored as null, nothing skipped", async () => {
    const { ctl, toasts } = make(
      () => [file("a.ts"), file("b.ts")],
      async (p) => {
        if (p === "b.ts") throw new ApiError("not found", 404);
        return { kind: "text", truncated: false, text: "A1" };
      },
    );
    await ctl.set();
    expect(ctl.checkpoint?.texts.get("a.ts")).toBe("A1");
    expect(ctl.checkpoint?.texts.has("b.ts")).toBe(true);
    expect(ctl.checkpoint?.texts.get("b.ts")).toBeNull();
    expect(ctl.checkpoint?.skipped).toEqual([]);
    expect(toasts).toEqual(["Checkpoint set (2 files)"]);
  });

  test("500 on b.ts: skipped, not stored", async () => {
    const { ctl, toasts } = make(
      () => [file("a.ts"), file("b.ts")],
      async (p) => {
        if (p === "b.ts") throw new ApiError("boom", 500);
        return { kind: "text", truncated: false, text: "A1" };
      },
    );
    await ctl.set();
    expect(ctl.checkpoint?.texts.has("b.ts")).toBe(false);
    expect(ctl.checkpoint?.skipped).toEqual(["b.ts"]);
    expect(toasts).toEqual(["Checkpoint set (1 files, 1 skipped)"]);
  });

  test("the file reappearing is offered as added", async () => {
    let listing = [file("a.ts"), file("b.ts")];
    let gone = true;
    const { ctl, picked, diffs } = make(
      () => listing,
      async (p) => {
        if (p === "b.ts" && gone) throw new ApiError("not found", 404);
        return { kind: "text", truncated: false, text: p === "b.ts" ? "new" : "A1" };
      },
    );
    await ctl.set();
    gone = false;
    listing = [file("a.ts"), file("b.ts", "A")];
    await ctl.since();
    const item = picked[0]?.find((i) => i.label === "b.ts");
    expect(item).toBeDefined();
    item!.run();
    expect(diffs[0]?.status).toBe("A");
    expect(diffs[0]?.oldText).toBeNull();
    expect(diffs[0]?.newText).toBe("new");
  });
});
