import { describe, expect, test } from "bun:test";
import { copyImageKey } from "../src/client/keys.ts";

const ev = (o: object) => ({ key: "C", ...o });

describe("AC-6 copyImageKey", () => {
  test("mac: Cmd+Shift+C outside the terminal", () => {
    expect(copyImageKey(ev({ metaKey: true, shiftKey: true }), { isMac: true, inTerm: false })).toBe(true);
    expect(copyImageKey(ev({ key: "c", metaKey: true, shiftKey: true }), { isMac: true, inTerm: false })).toBe(true);
  });
  test("non-mac: Ctrl+Shift+C outside the terminal", () => {
    expect(copyImageKey(ev({ ctrlKey: true, shiftKey: true }), { isMac: false, inTerm: false })).toBe(true);
  });
  test("false in the terminal", () => {
    expect(copyImageKey(ev({ metaKey: true, shiftKey: true }), { isMac: true, inTerm: true })).toBe(false);
    expect(copyImageKey(ev({ ctrlKey: true, shiftKey: true }), { isMac: false, inTerm: true })).toBe(false);
  });
  test("false without shift, without the right modifier, with alt, or for another key", () => {
    expect(copyImageKey(ev({ metaKey: true }), { isMac: true, inTerm: false })).toBe(false);
    expect(copyImageKey(ev({ ctrlKey: true, shiftKey: true }), { isMac: true, inTerm: false })).toBe(false);
    expect(copyImageKey(ev({ metaKey: true, shiftKey: true }), { isMac: false, inTerm: false })).toBe(false);
    expect(copyImageKey(ev({ metaKey: true, shiftKey: true, altKey: true }), { isMac: true, inTerm: false })).toBe(false);
    expect(copyImageKey(ev({ key: "V", metaKey: true, shiftKey: true }), { isMac: true, inTerm: false })).toBe(false);
  });
});
