import { describe, expect, test } from "bun:test";
import { snapTracker } from "../src/client/copyimage.ts";

describe("snapTracker", () => {
  test("ids are unique per request", () => {
    const t = snapTracker();
    const a = t.begin();
    t.accept(a);
    const b = t.begin();
    expect(b).not.toBe(a);
    expect(typeof a).toBe("number");
  });
  test("accepts the pending id exactly once", () => {
    const t = snapTracker();
    const id = t.begin();
    expect(t.accept(id)).toBe(true);
    expect(t.accept(id)).toBe(false);
  });
  test("ignores stale, unknown and malformed ids", () => {
    const t = snapTracker();
    const old = t.begin();
    const cur = t.begin();
    expect(t.accept(old)).toBe(false);
    expect(t.accept(undefined)).toBe(false);
    expect(t.accept("1")).toBe(false);
    expect(t.accept(cur + 100)).toBe(false);
    expect(t.accept(cur)).toBe(true);
  });
  test("cancel returns the pending id and a late reply is ignored", () => {
    const t = snapTracker();
    const id = t.begin();
    expect(t.cancel()).toBe(id);
    expect(t.accept(id)).toBe(false);
    expect(t.cancel()).toBeUndefined();
  });
  test("no pending request: cancel is undefined, accept false", () => {
    const t = snapTracker();
    expect(t.cancel()).toBeUndefined();
    expect(t.accept(0)).toBe(false);
  });
});
