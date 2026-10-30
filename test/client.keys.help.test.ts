import { describe, expect, test } from "bun:test";
import { helpKey } from "../src/client/keys.ts";

// Key values below were recorded from WKWebView on macOS with the German layout:
// Cmd+Shift+7 arrives as key "7", code "Digit7", never as "/".
describe("helpKey", () => {
  test("US layout: Cmd+/ on a Mac, Ctrl+/ elsewhere", () => {
    expect(helpKey({ key: "/", code: "Slash", metaKey: true }, { isMac: true })).toBe(true);
    expect(helpKey({ key: "/", code: "Slash", ctrlKey: true }, { isMac: false })).toBe(true);
  });

  test("German layout on a Mac: Cmd+Shift+7 opens the sheet", () => {
    expect(helpKey({ key: "7", code: "Digit7", metaKey: true, shiftKey: true }, { isMac: true })).toBe(true);
  });

  test("German layout on Linux: Ctrl+Shift+7 reports '/'", () => {
    expect(helpKey({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }, { isMac: false })).toBe(true);
  });

  test("does not steal neighbouring shortcuts", () => {
    // German: the US slash position is "-", Cmd+- is zoom out.
    expect(helpKey({ key: "-", code: "Slash", metaKey: true }, { isMac: true })).toBe(false);
    expect(helpKey({ key: "_", code: "Slash", metaKey: true, shiftKey: true }, { isMac: true })).toBe(false);
    // Cmd+7 without Shift, and a bare Shift+7.
    expect(helpKey({ key: "7", code: "Digit7", metaKey: true }, { isMac: true })).toBe(false);
    expect(helpKey({ key: "/", code: "Digit7", shiftKey: true }, { isMac: true })).toBe(false);
    // Wrong modifier for the platform.
    expect(helpKey({ key: "/", code: "Slash", ctrlKey: true }, { isMac: true })).toBe(false);
    expect(helpKey({ key: "/", code: "Slash", metaKey: true }, { isMac: false })).toBe(false);
  });
});
