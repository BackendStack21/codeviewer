import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let G: typeof import("../src/client/mdgate.ts");
beforeAll(async () => {
  installDom();
  try {
    G = await import("../src/client/mdgate.ts");
  } catch {}
});
afterAll(() => uninstallDom());

describe("AC-22 decidePreview (pure)", () => {
  test("the cap is 1 MiB", () => {
    expect(G.MAX_PREVIEW_BYTES).toBe(1024 * 1024);
  });

  test("a small file previews with no note and no pill", () => {
    expect(G.decidePreview(10, false)).toEqual({ preview: true, tooLarge: false, pill: false });
    expect(G.decidePreview(0, false)).toEqual({ preview: true, tooLarge: false, pill: false });
  });

  test("exactly 1 MiB previews; one byte more is too large", () => {
    expect(G.decidePreview(1048576, false).preview).toBe(true);
    expect(G.decidePreview(1048577, false)).toEqual({ preview: false, tooLarge: true, pill: false });
  });

  test("Render anyway forces the preview of a large file", () => {
    expect(G.decidePreview(5 * 1024 * 1024, false, true)).toEqual({ preview: true, tooLarge: false, pill: false });
  });

  test("a truncated file shows the pill above the preview", () => {
    expect(G.decidePreview(100, true)).toEqual({ preview: true, tooLarge: false, pill: true });
    expect(G.decidePreview(8 * 1024 * 1024, true, true)).toEqual({ preview: true, tooLarge: false, pill: true });
  });

  test("a large truncated file is gated first and shows no preview pill", () => {
    expect(G.decidePreview(8 * 1024 * 1024, true)).toEqual({ preview: false, tooLarge: true, pill: false });
  });
});

describe("AC-22 tooLargeNote", () => {
  test("says Too large to preview and offers Render anyway", () => {
    const el = G.tooLargeNote(() => {}) as unknown as FakeElement;
    expect(el.textContent).toContain("Too large to preview");
    const btn = el.querySelectorAll<FakeElement>("button");
    expect(btn.length).toBe(1);
    expect(btn[0]!.textContent).toContain("Render anyway");
  });

  test("clicking Render anyway calls the callback once", () => {
    let n = 0;
    const el = G.tooLargeNote(() => void n++) as unknown as FakeElement;
    el.querySelectorAll<FakeElement>("button")[0]!.dispatchEvent(new FakeEvent("click", { button: 0 }));
    expect(n).toBe(1);
  });
});
