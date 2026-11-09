import { describe, expect, test } from "bun:test";
import { ApiError, type ChangeFile } from "../src/client/api.ts";
import { checkpointText, CheckpointController, type CheckpointDeps } from "../src/client/checkpointctl.ts";

const file = (path: string, over: Partial<ChangeFile> = {}): ChangeFile => ({ path, status: "M", added: null, removed: null, binary: false, ...over });

function make(files: ChangeFile[]) {
  const toasts: string[] = [];
  const deps: CheckpointDeps = {
    changes: async () => ({ repo: true, rev: "R", files }),
    readText: (p) =>
      checkpointText(async () => {
        if (p === "gone.ts" || p === "link") throw new ApiError("not found", 404);
        return { kind: "text", truncated: false, text: "A1" };
      }),
    baseText: async () => undefined,
    now: () => 1,
    notify: (m) => void toasts.push(m),
    pick: () => {},
    openDiff: () => {},
  };
  return { ctl: new CheckpointController(deps), toasts };
}

describe("a 404 for a symlink is not a deletion", () => {
  test("a symlink entry whose read gives 404 is skipped, not stored", async () => {
    const { ctl, toasts } = make([file("a.ts"), file("link", { status: "A", newMode: "120000" })]);
    await ctl.set();
    expect(ctl.checkpoint?.texts.has("link")).toBe(false);
    expect(ctl.checkpoint?.skipped).toEqual(["link"]);
    expect(ctl.checkpoint?.texts.get("a.ts")).toBe("A1");
    expect(toasts).toEqual(["Checkpoint set (1 files, 1 skipped)"]);
  });

  test("a regular entry's 404 is still recorded as deleted", async () => {
    const { ctl } = make([file("a.ts"), file("gone.ts", { newMode: "100644" })]);
    await ctl.set();
    expect(ctl.checkpoint?.texts.has("gone.ts")).toBe(true);
    expect(ctl.checkpoint?.texts.get("gone.ts")).toBeNull();
    expect(ctl.checkpoint?.skipped).toEqual([]);
  });

  test("an entry without a mode is treated as regular", async () => {
    const { ctl } = make([file("gone.ts")]);
    await ctl.set();
    expect(ctl.checkpoint?.texts.get("gone.ts")).toBeNull();
  });
});
