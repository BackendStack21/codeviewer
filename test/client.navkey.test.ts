import { describe, expect, test } from "bun:test";
import { navKey } from "../src/client/keys.ts";

const mac = { isMac: true, inTerm: false };
const lin = { isMac: false, inTerm: false };

describe("navKey on macOS", () => {
  test("Ctrl+- goes back", () => {
    expect(navKey({ key: "-", code: "Minus", ctrlKey: true }, mac)).toBe("back");
  });
  test("Ctrl+Shift+- (or _) goes forward", () => {
    expect(navKey({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }, mac)).toBe("forward");
    expect(navKey({ key: "-", code: "Minus", ctrlKey: true, shiftKey: true }, mac)).toBe("forward");
  });
  test("any Meta or Alt disqualifies (Cmd+- is zoom out)", () => {
    expect(navKey({ key: "-", ctrlKey: true, metaKey: true }, mac)).toBeNull();
    expect(navKey({ key: "-", metaKey: true }, mac)).toBeNull();
    expect(navKey({ key: "-", ctrlKey: true, altKey: true }, mac)).toBeNull();
    expect(navKey({ key: "_", ctrlKey: true, shiftKey: true, metaKey: true }, mac)).toBeNull();
    expect(navKey({ key: "_", ctrlKey: true, shiftKey: true, altKey: true }, mac)).toBeNull();
  });
  test("plain minus and Cmd-less keys are not navigation", () => {
    expect(navKey({ key: "-" }, mac)).toBeNull();
    expect(navKey({ key: "-", shiftKey: true }, mac)).toBeNull();
  });
});

describe("navKey on Linux", () => {
  test("Ctrl+Alt+- goes back", () => {
    expect(navKey({ key: "-", code: "Minus", ctrlKey: true, altKey: true }, lin)).toBe("back");
  });
  test("Ctrl+Shift+- (or _) goes forward", () => {
    expect(navKey({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }, lin)).toBe("forward");
    expect(navKey({ key: "-", code: "Minus", ctrlKey: true, shiftKey: true }, lin)).toBe("forward");
  });
  test("plain Ctrl+- is zoom out, not navigation", () => {
    expect(navKey({ key: "-", code: "Minus", ctrlKey: true }, lin)).toBeNull();
  });
  test("Meta, or Alt without Ctrl, is not navigation", () => {
    expect(navKey({ key: "-", altKey: true }, lin)).toBeNull();
    expect(navKey({ key: "-", ctrlKey: true, altKey: true, metaKey: true }, lin)).toBeNull();
  });
});

describe("navKey everywhere", () => {
  test("never inside the terminal, on either platform", () => {
    expect(navKey({ key: "-", ctrlKey: true }, { isMac: true, inTerm: true })).toBeNull();
    expect(navKey({ key: "_", ctrlKey: true, shiftKey: true }, { isMac: true, inTerm: true })).toBeNull();
    expect(navKey({ key: "-", ctrlKey: true, altKey: true }, { isMac: false, inTerm: true })).toBeNull();
    expect(navKey({ key: "_", ctrlKey: true, shiftKey: true }, { isMac: false, inTerm: true })).toBeNull();
  });
  test("unrelated keys are null", () => {
    expect(navKey({ key: "o", ctrlKey: true }, mac)).toBeNull();
    expect(navKey({ key: "=", ctrlKey: true, altKey: true }, lin)).toBeNull();
    expect(navKey({ key: "0", ctrlKey: true, shiftKey: true }, lin)).toBeNull();
  });
  test("matches by e.key, so a German layout (own minus key, odd code) works", () => {
    expect(navKey({ key: "-", code: "Slash", ctrlKey: true }, mac)).toBe("back");
    expect(navKey({ key: "-", code: "Slash", ctrlKey: true, altKey: true }, lin)).toBe("back");
    expect(navKey({ key: "_", code: "Slash", ctrlKey: true, shiftKey: true }, lin)).toBe("forward");
  });
});
