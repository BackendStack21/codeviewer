import { describe, expect, test } from "bun:test";
import { snapTracker } from "../src/client/copyimage.ts";

// R-04: a request's timeout cancels only its own id; a new request supersedes (cancels) the pending one first.
describe("snapTracker targeted cancel", () => {
  test("cancel(id) of a stale request does not touch the newer pending one", () => {
    const t = snapTracker();
    const a = t.begin();
    const b = t.begin();
    expect(t.cancel(a)).toBeUndefined();
    expect(t.accept(b)).toBe(true);
  });
  test("cancel(id) of the pending request returns it and drops its reply", () => {
    const t = snapTracker();
    const a = t.begin();
    expect(t.cancel(a)).toBe(a);
    expect(t.accept(a)).toBe(false);
    expect(t.cancel(a)).toBeUndefined();
  });
  test("superseding: cancel() before begin() yields the old id, which can no longer be accepted", () => {
    const t = snapTracker();
    const a = t.begin();
    const old = t.cancel();
    const b = t.begin();
    expect(old).toBe(a);
    expect(t.accept(a)).toBe(false);
    expect(t.accept(b)).toBe(true);
  });
  test("cancel(unknown id) is a no-op", () => {
    const t = snapTracker();
    const a = t.begin();
    expect(t.cancel(a + 5)).toBeUndefined();
    expect(t.accept(a)).toBe(true);
  });
});
