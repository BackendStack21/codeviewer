import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let C: typeof import("../src/client/mdcommands.ts");
let P: typeof import("../src/client/palette.ts");
beforeAll(async () => {
  installDom();
  try {
    C = await import("../src/client/mdcommands.ts");
    P = await import("../src/client/palette.ts");
  } catch {}
});
afterAll(() => uninstallDom());

const host = (md: boolean) => {
  const h = { toggles: 0, isMarkdownTab: () => md, toggleMarkdown: () => void h.toggles++ };
  return h;
};

describe("AC-23 Toggle Markdown Preview command", () => {
  test("has the documented label and a stable id", () => {
    const c = C.markdownToggleCommand(host(true));
    expect(c.label).toBe("Toggle Markdown Preview");
    expect(c.id.length).toBeGreaterThan(0);
  });

  test("on a Markdown tab it toggles once per run", () => {
    const h = host(true);
    const c = C.markdownToggleCommand(h);
    c.run();
    c.run();
    expect(h.toggles).toBe(2);
  });

  test("on any other tab it does nothing", () => {
    const h = host(false);
    C.markdownToggleCommand(h).run();
    expect(h.toggles).toBe(0);
  });

  test("it is found and run through the real palette", () => {
    const m = mockFetch(() => new Response("a.ts"));
    try {
      const h = host(true);
      const p = new P.Palette();
      p.commands = [C.markdownToggleCommand(h)];
      const input = p.el.querySelector<FakeElement>(".palette-input")!;
      p.open(">");
      input.value = ">markdown prev";
      input.dispatchEvent(new FakeEvent("input"));
      input.dispatchEvent(new FakeEvent("keydown", { key: "Enter" }));
      expect(h.toggles).toBe(1);
    } finally {
      m.restore();
    }
  });
});
