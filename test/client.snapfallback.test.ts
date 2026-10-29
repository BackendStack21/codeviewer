import { describe, expect, test } from "bun:test";
import { clampSnapRect, copyPngOrSnapshot, copyViaSnapshot, type CopyImageDeps, type SnapshotDeps } from "../src/client/copyimage.ts";

const vp = { width: 800, height: 600 };
const blob = new Blob(["png"], { type: "image/png" });
const B64 = btoa("PNGDATA");
const rej = () => Promise.reject(new Error("SecurityError"));

describe("clampSnapRect", () => {
  test("unions rects", () => {
    expect(clampSnapRect([{ left: 10, top: 20, width: 100, height: 10 }, { left: 10, top: 30, width: 50, height: 10 }], vp)).toEqual({ x: 10, y: 20, w: 100, h: 20 });
  });
  test("clamps to the viewport", () => {
    expect(clampSnapRect([{ left: -20, top: -5, width: 1000, height: 700 }], vp)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
  test("null when empty or fully outside", () => {
    expect(clampSnapRect([], vp)).toBeNull();
    expect(clampSnapRect([{ left: 900, top: 10, width: 50, height: 10 }], vp)).toBeNull();
    expect(clampSnapRect([{ left: 10, top: 10, width: 0, height: 10 }], vp)).toBeNull();
  });
});

function mk(log: string[], snap?: SnapshotDeps["snapshot"], over: Partial<CopyImageDeps> = {}): CopyImageDeps & SnapshotDeps {
  return {
    renderPng: async () => blob,
    native: async () => void log.push("native"),
    notify: () => {},
    compose: async (p) => p,
    snapshot: snap,
    hideSelection: (on) => void log.push(on ? "hide" : "show"),
    ...over,
  };
}
const rects = [{ left: 5, top: 5, width: 100, height: 20 }];

describe("copyViaSnapshot", () => {
  test("hides, snapshots the clamped rect, restores", async () => {
    const log: string[] = [];
    let got: unknown;
    const ok = await copyViaSnapshot(mk(log, async (r) => ((got = r), B64)), rects, vp);
    expect(ok).toBe(true);
    expect(got).toEqual({ x: 5, y: 5, w: 100, h: 20 });
    expect(log).toEqual(["hide", "show", "native"]);
  });
  test("false and restored when the snapshot fails or throws", async () => {
    const log: string[] = [];
    expect(await copyViaSnapshot(mk(log, async () => null), rects, vp)).toBe(false);
    expect(await copyViaSnapshot(mk(log, async () => { throw new Error("x"); }), rects, vp)).toBe(false);
    expect(log).toEqual(["hide", "show", "hide", "show"]);
  });
  test("false without a snapshot bridge or visible rect, never hiding", async () => {
    const log: string[] = [];
    expect(await copyViaSnapshot(mk(log), rects, vp)).toBe(false);
    expect(await copyViaSnapshot(mk(log, async () => B64), [], vp)).toBe(false);
    expect(log).toEqual([]);
  });
});

describe("copyPngOrSnapshot", () => {
  test("PNG ok: no snapshot", async () => {
    const log: string[] = [];
    let called = false;
    expect(await copyPngOrSnapshot(mk(log, async () => ((called = true), B64)), Promise.resolve(blob), rects, vp)).toBe("native");
    expect(called).toBe(false);
  });
  test("PNG fails + snapshot ok -> snapshot", async () => {
    expect(await copyPngOrSnapshot(mk([], async () => B64), rej(), rects, vp)).toBe("snapshot");
  });
  test("PNG fails + snapshot fails or unavailable -> failed", async () => {
    expect(await copyPngOrSnapshot(mk([], async () => null), rej(), rects, vp)).toBe("failed");
    expect(await copyPngOrSnapshot(mk([]), rej(), rects, vp)).toBe("failed");
  });
});
