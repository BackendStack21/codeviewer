import { describe, expect, test } from "bun:test";
import type { ChangeFile } from "../src/client/api.ts";
import { CheckpointController, type CheckpointDeps } from "../src/client/checkpointctl.ts";

const file = (path: string, status: ChangeFile["status"] = "M", extra: Partial<ChangeFile> = {}): ChangeFile => ({
  path,
  status,
  added: null,
  removed: null,
  binary: false,
  ...extra,
});

type Listing = { repo: boolean; rev: string | null; files: ChangeFile[] };

function make(over: Partial<CheckpointDeps> = {}, listing: () => Promise<Listing> = async () => ({ repo: true, rev: "R", files: [] })) {
  const toasts: string[] = [];
  const texts: Record<string, string | null | undefined> = {};
  const deps: CheckpointDeps = {
    changes: () => listing(),
    readText: async (p) => texts[p],
    baseText: async () => undefined,
    now: () => 1,
    notify: (m) => void toasts.push(m),
    pick: () => {},
    openDiff: () => {},
    ...over,
  };
  return { ctl: new CheckpointController(deps), toasts, texts };
}

describe("R-01 a rename always records the old path as deleted", () => {
  test("binary new path: old path stored as null, new path skipped", async () => {
    const { ctl, toasts } = make({}, async () => ({ repo: true, rev: "R", files: [file("new.png", "R", { oldPath: "old.png", binary: true })] }));
    await expect(ctl.set()).resolves.toBeUndefined();
    expect([...(ctl.checkpoint?.texts.entries() ?? [])]).toEqual([["old.png", null]]);
    expect(ctl.checkpoint?.skipped).toEqual(["new.png"]);
    expect(toasts).toEqual(["Checkpoint set (1 files, 1 skipped)"]);
  });

  test("unreadable new path: old path stored as null, new path skipped", async () => {
    const { ctl } = make({}, async () => ({ repo: true, rev: "R", files: [file("new.ts", "R", { oldPath: "old.ts" })] }));
    await expect(ctl.set()).resolves.toBeUndefined();
    expect([...(ctl.checkpoint?.texts.entries() ?? [])]).toEqual([["old.ts", null]]);
    expect(ctl.checkpoint?.skipped).toEqual(["new.ts"]);
  });
});

describe("R-02 clear during an in-flight set wins", () => {
  test("no checkpoint and no 'Checkpoint set' toast after the listing resolves", async () => {
    let release: (l: Listing) => void = () => {};
    const { ctl, toasts, texts } = make({}, () => new Promise<Listing>((r) => (release = r)));
    texts["a.ts"] = "x";
    const pending = ctl.set();
    ctl.clear();
    release({ repo: true, rev: "R", files: [file("a.ts")] });
    await expect(pending).resolves.toBeUndefined();
    expect(ctl.checkpoint).toBeNull();
    expect(toasts).toEqual(["Checkpoint cleared"]);
  });
});

describe("R-04 a failing base read", () => {
  test("since resolves and says it could not compare", async () => {
    let first = true;
    const { ctl, toasts, texts } = make(
      {
        baseText: async () => {
          throw new Error("boom");
        },
      },
      async () => ({ repo: true, rev: "R", files: [file(first ? "a.ts" : "b.ts", first ? "M" : "?")] }),
    );
    texts["a.ts"] = "x\n";
    texts["b.ts"] = "y\n";
    await ctl.set();
    expect(ctl.checkpoint).not.toBeNull();
    first = false; // a.ts is no longer listed and b.ts is new: both need a base, which rejects
    await expect(ctl.since()).resolves.toBeUndefined();
    expect(toasts.at(-1)).toBe("Could not compare with the checkpoint");
    expect(ctl.checkpoint).not.toBeNull();
  });
});
