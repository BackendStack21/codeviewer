import { describe, expect, test } from "bun:test";
import { copyViaSnapshot, pngFromBase64, type SnapRect, type SnapshotDeps } from "../src/client/copyimage.ts";

// AC-12: the native snapshot replies with base64 PNG; JS decodes, composes the frame, then writes via the native pasteboard handler.
const vp = { width: 800, height: 600 };
const rects = [{ left: 5, top: 5, width: 100, height: 20 }];
const B64 = btoa("PNGDATA");

interface Probe {
  log: string[];
  composed?: { text: string; type: string; rect: SnapRect };
  written?: Blob;
}
function mk(p: Probe, over: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    hideSelection: (on) => void p.log.push(on ? "hide" : "show"),
    snapshot: async () => B64,
    compose: async (png, rect) => {
      p.composed = { text: await png.text(), type: png.type, rect };
      p.log.push("compose");
      return new Blob(["FRAMED"], { type: "image/png" });
    },
    native: async (b) => {
      p.written = b;
      p.log.push("native");
    },
    ...over,
  };
}

describe("pngFromBase64", () => {
  test("decodes to an image/png blob", async () => {
    const b = pngFromBase64(B64);
    expect(b.type).toBe("image/png");
    expect(await b.text()).toBe("PNGDATA");
  });
});

describe("copyViaSnapshot base64 flow (AC-12)", () => {
  test("decodes, composes with the clamped rect, writes the composed blob natively", async () => {
    const p: Probe = { log: [] };
    expect(await copyViaSnapshot(mk(p), rects, vp)).toBe(true);
    expect(p.composed).toEqual({ text: "PNGDATA", type: "image/png", rect: { x: 5, y: 5, w: 100, h: 20 } });
    expect(await p.written!.text()).toBe("FRAMED");
    expect(p.log[0]).toBe("hide");
    expect(p.log.filter((l) => l === "show")).toHaveLength(1);
    expect(p.log.indexOf("compose")).toBeLessThan(p.log.indexOf("native"));
  });
  test("a compose failure returns false, writes nothing and restores the highlight", async () => {
    const p: Probe = { log: [] };
    const ok = await copyViaSnapshot(mk(p, { compose: async () => { throw new Error("canvas"); } }), rects, vp);
    expect(ok).toBe(false);
    expect(p.written).toBeUndefined();
    expect(p.log.filter((l) => l === "show")).toHaveLength(1);
  });
  test("a native write failure returns false", async () => {
    const p: Probe = { log: [] };
    expect(await copyViaSnapshot(mk(p, { native: async () => { throw new Error("pb"); } }), rects, vp)).toBe(false);
    expect(p.log.filter((l) => l === "show")).toHaveLength(1);
  });
  test("no PNG data, or no compose/native writer, is a failure", async () => {
    const p: Probe = { log: [] };
    expect(await copyViaSnapshot(mk(p, { snapshot: async () => null }), rects, vp)).toBe(false);
    expect(await copyViaSnapshot(mk(p, { compose: undefined }), rects, vp)).toBe(false);
    expect(await copyViaSnapshot(mk(p, { native: undefined }), rects, vp)).toBe(false);
    expect(p.written).toBeUndefined();
  });
  test("the snapshot is asked for the request id from begin()", async () => {
    const p: Probe = { log: [] };
    let got: number | undefined;
    const deps = mk(p, { begin: () => 7, snapshot: async (_r, id) => ((got = id), B64) });
    expect(await copyViaSnapshot(deps, rects, vp)).toBe(true);
    expect(got).toBe(7);
  });
});

describe("snapshotDeps reply (AC-12, real deps with a fake bridge)", () => {
  test("__cvSnap(id, ok, base64) resolves the base64 once; ok=false or missing data resolves null", async () => {
    const win: any = {};
    const prevWin = (globalThis as any).window;
    (globalThis as any).window = win;
    (globalThis as any).document = { documentElement: { classList: { toggle() {} } } };
    (globalThis as any).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    const { snapshotDeps } = await import("../src/client/imagedom.ts?own-tracker");
    expect(typeof win.__cvSnap).toBe("function");
    const sent: any[] = [];
    const deps = snapshotDeps({ postMessage: (m: any) => sent.push(m) });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const rect = { x: 1, y: 2, w: 30, h: 40 };

    const a = deps.snapshot!(rect, deps.begin!());
    await sleep(15);
    const idA = sent.find((m) => m.t === "snapshotrect").id;
    win.__cvSnap(idA, true, B64);
    expect(await a).toBe(B64);

    const b = deps.snapshot!(rect, deps.begin!());
    await sleep(15);
    win.__cvSnap(sent.filter((m) => m.t === "snapshotrect").pop().id, false);
    expect(await b).toBeNull();

    const c = deps.snapshot!(rect, deps.begin!());
    await sleep(15);
    win.__cvSnap(sent.filter((m) => m.t === "snapshotrect").pop().id, true); // ok without data
    expect(await c).toBeNull();
    (globalThis as any).window = prevWin;
  });
});
