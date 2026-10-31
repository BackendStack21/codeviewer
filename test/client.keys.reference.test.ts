import { describe, expect, test } from "bun:test";
import { referenceKey, symbolKey } from "../src/client/keys.ts";

describe("symbolKey (Go to Symbol)", () => {
  test("Cmd+Shift+O on a Mac, Ctrl+Shift+O elsewhere", () => {
    expect(symbolKey({ key: "O", code: "KeyO", metaKey: true, shiftKey: true }, { isMac: true })).toBe(true);
    expect(symbolKey({ key: "O", code: "KeyO", ctrlKey: true, shiftKey: true }, { isMac: false })).toBe(true);
  });
  test("not without Shift, not with Alt, not with the other platform's modifier", () => {
    expect(symbolKey({ key: "o", metaKey: true }, { isMac: true })).toBe(false);
    expect(symbolKey({ key: "O", metaKey: true, shiftKey: true, altKey: true }, { isMac: true })).toBe(false);
    expect(symbolKey({ key: "O", ctrlKey: true, shiftKey: true }, { isMac: true })).toBe(false);
  });
});

describe("referenceKey (Copy Reference)", () => {
  test("Cmd+Option+C on a Mac, where Option makes the key a symbol", () => {
    expect(referenceKey({ key: "ç", code: "KeyC", metaKey: true, altKey: true }, { isMac: true })).toBe(true);
    expect(referenceKey({ key: "c", code: "KeyC", metaKey: true, altKey: true }, { isMac: true })).toBe(true);
  });
  test("Ctrl+Alt+C elsewhere", () => {
    expect(referenceKey({ key: "c", code: "KeyC", ctrlKey: true, altKey: true }, { isMac: false })).toBe(true);
  });
  test("a layout with another letter on the C key (Dvorak: J) does not match; its own C does", () => {
    expect(referenceKey({ key: "j", code: "KeyC", ctrlKey: true, altKey: true }, { isMac: false })).toBe(false);
    expect(referenceKey({ key: "c", code: "KeyI", ctrlKey: true, altKey: true }, { isMac: false })).toBe(true);
  });
  test("plain copy and Shift variants are left alone", () => {
    expect(referenceKey({ key: "c", code: "KeyC", metaKey: true }, { isMac: true })).toBe(false);
    expect(referenceKey({ key: "C", code: "KeyC", metaKey: true, altKey: true, shiftKey: true }, { isMac: true })).toBe(false);
  });
});
