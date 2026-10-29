import { describe, expect, test } from "bun:test";
import { readSelection, snapshotText } from "../src/client/copyentry.ts";

class FakeRange {
  constructor(public text: string) {}
  clones = 0;
  cloneRange() {
    this.clones++;
    return new FakeRange(this.text);
  }
  toString() {
    return this.text;
  }
}
type C = { id: string };

describe("R-02 readSelection clones the markdown Range", () => {
  test("returns a clone, not the live Range, and the clone survives the live one changing", () => {
    const live = new FakeRange("hello");
    const snap = readSelection<C, FakeRange>({ md: { selectionRange: () => live } });
    expect(snap?.md).toBeDefined();
    expect(snap!.md).not.toBe(live);
    expect(live.clones).toBe(1);
    live.text = "";
    expect(snap!.md!.toString()).toBe("hello");
  });
  test("no markdown selection, or no tab: null", () => {
    expect(readSelection<C, FakeRange>({ md: { selectionRange: () => null } })).toBeNull();
    expect(readSelection<C, FakeRange>(undefined)).toBeNull();
  });
  test("code tab: the model range is captured", () => {
    const sel = { id: "a" };
    expect(readSelection<C, FakeRange>({ code: { selection: sel, selectedText: () => "" } })).toEqual({ code: sel });
    expect(readSelection<C, FakeRange>({ code: { selection: null, selectedText: () => "" } })).toBeNull();
  });
});

describe("R-01 snapshotText uses the captured selection", () => {
  const codeTab = (live: C | null) => ({ code: { selection: live, selectedText: (r?: C) => `text:${(r ?? live)?.id ?? ""}` } });
  test("code: text of the captured range even after the live selection moved", () => {
    expect(snapshotText<C, FakeRange>(codeTab({ id: "live" }), { code: { id: "captured" } })).toBe("text:captured");
  });
  test("markdown: text of the captured Range", () => {
    expect(snapshotText<C, FakeRange>({ md: { selectionRange: () => null } }, { md: new FakeRange("captured") })).toBe("captured");
  });
  test("no snapshot: empty string", () => {
    expect(snapshotText<C, FakeRange>(codeTab({ id: "live" }), null)).toBe("");
    expect(snapshotText<C, FakeRange>(undefined, undefined)).toBe("");
  });
});
