import { describe, expect, test } from "bun:test";
import { copyViaSnapshot, snapTracker } from "../src/client/copyimage.ts";

// R-05: the selection hide is owned by a request id; a superseded request's cleanup must not un-hide for the newer one.
describe("snapTracker hide ownership", () => {
  test("a superseded owner cannot release; the newer owner can, once", () => {
    const t = snapTracker();
    const a = t.begin();
    t.claimHide(a);
    const b = t.begin();
    t.claimHide(b);
    expect(t.releaseHide(a)).toBe(false);
    expect(t.releaseHide(b)).toBe(true);
    expect(t.releaseHide(b)).toBe(false);
  });
  test("the sole owner releases exactly once", () => {
    const t = snapTracker();
    const a = t.begin();
    t.claimHide(a);
    expect(t.releaseHide(a)).toBe(true);
    expect(t.releaseHide(a)).toBe(false);
  });
  test("an id that never claimed cannot release", () => {
    const t = snapTracker();
    const a = t.begin();
    expect(t.releaseHide(a)).toBe(false);
  });
});

// End to end through the real deps with a fake DOM and bridge.
let on = false;
const log: string[] = [];
// imagedom is a cached module: share one window object across test files so its __cvSnap hook lands on it.
const win: any = ((globalThis as any).window ??= {});
(globalThis as any).document = {
  documentElement: { classList: { toggle: (_c: string, v: boolean) => { on = v; log.push(v ? "hide" : "show"); } } },
};
(globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
const { snapshotDeps } = await import("../src/client/imagedom.ts");

const rects = [{ left: 5, top: 5, width: 100, height: 20 }];
const vp = { width: 800, height: 600 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("overlapping Copy as Image", () => {
  test("the highlight stays hidden when the newer request captures, and is removed afterwards", async () => {
    on = false;
    log.length = 0;
    const msgs: { t: string; id: number; hideAtPost: boolean }[] = [];
    const deps = { ...snapshotDeps({ postMessage: (m: any) => msgs.push({ ...m, hideAtPost: on }) }), compose: async (p: Blob) => p, native: async () => {} };
    const pA = copyViaSnapshot(deps, rects, vp);
    await sleep(5);
    const pB = copyViaSnapshot(deps, rects, vp);
    await sleep(20);
    const shotB = msgs.find((m) => m.t === "snapshotrect" && m.id === 2)!;
    expect(shotB).toBeDefined();
    expect(shotB.hideAtPost).toBe(true);
    expect(on).toBe(true);
    win.__cvSnap(2, true, btoa("PNGDATA"));
    expect(await pB).toBe(true);
    expect(await pA).toBe(false);
    expect(on).toBe(false);
  });
});
