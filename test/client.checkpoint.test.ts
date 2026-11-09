import { describe, expect, test } from "bun:test";
import { sinceCheckpoint, takeCheckpoint, type Checkpoint } from "../src/client/checkpoint.ts";

type F = { path: string; text: string | null };
const f = (path: string, text: string | null): F => ({ path, text });
const keys = (cp: Checkpoint) => [...cp.texts.keys()];
/** A base stub: undefined for any path not named. */
const baseOf = (m: Record<string, string | null>) => (p: string) => (p in m ? m[p] : undefined);
const cur = (o: Record<string, string | null>) => new Map(Object.entries(o));
const since = (files: F[], current: Record<string, string | null>, base: Record<string, string | null> = {}) =>
  sinceCheckpoint(takeCheckpoint(files, 1, "R"), cur(current), baseOf(base));

describe("takeCheckpoint", () => {
  test("AC-1 stores texts in order and keeps at and rev", () => {
    const cp = takeCheckpoint([f("a", "x"), f("b", null)], 1700000000000, "R");
    expect(cp.at).toBe(1700000000000);
    expect(cp.rev).toBe("R");
    expect(cp.skipped).toEqual([]);
    expect([...cp.texts.entries()]).toEqual([["a", "x"], ["b", null]]);
    expect(cp.texts.size).toBe(2);
    expect(cp.texts.get("b")).toBeNull();
    expect(cp.texts.has("b")).toBe(true);
    expect(takeCheckpoint([f("a", "x")], 1, null).rev).toBeNull();
  });

  test("AC-1 the result is a copy of the input", () => {
    const files = [f("a", "x"), f("b", "y")];
    const cp = takeCheckpoint(files, 1, "R", { files: 2 });
    files.push(f("c", "z"));
    files[0]!.text = "changed";
    expect(cp.texts.get("a")).toBe("x");
    expect(keys(cp)).toEqual(["a", "b"]);
    expect(cp.skipped).toEqual([]);
    expect(cp as unknown).not.toBe(files);
  });

  test("AC-2 chars limit skips a big file but a later small one still fits", () => {
    const cp = takeCheckpoint([f("a", "12345"), f("b", "1234567890"), f("c", "123")], 0, null, { chars: 8 });
    expect(keys(cp)).toEqual(["a", "c"]);
    expect(cp.skipped).toEqual(["b"]);
  });

  test("AC-2 files limit", () => {
    const files = [f("a", "x"), f("b", "y"), f("c", "z")];
    const two = takeCheckpoint(files, 0, null, { files: 2 });
    expect(keys(two)).toEqual(["a", "b"]);
    expect(two.skipped).toEqual(["c"]);
    const none = takeCheckpoint(files, 0, null, { files: 0 });
    expect(keys(none)).toEqual([]);
    expect(none.skipped).toEqual(["a", "b", "c"]);
  });

  test("AC-2 null and empty texts count as zero characters", () => {
    const files = [f("a", "123456"), f("b", null), f("c", ""), f("d", "12")];
    const six = takeCheckpoint(files, 0, null, { chars: 6 });
    expect(keys(six)).toEqual(["a", "b", "c"]);
    expect(six.skipped).toEqual(["d"]);
    const zero = takeCheckpoint(files, 0, null, { chars: 0 });
    expect(keys(zero)).toEqual(["b", "c"]);
    expect(zero.skipped).toEqual(["a", "d"]);
  });

  test("AC-2 each limit keeps the other's default", () => {
    expect(takeCheckpoint([f("a", "x".repeat(20))], 0, null, { files: 5 }).texts.has("a")).toBe(true);
    const many = Array.from({ length: 501 }, (_, i) => f("f" + i, "x"));
    const cp = takeCheckpoint(many, 0, null);
    expect(cp.texts.size).toBe(500);
    expect(cp.skipped).toEqual(["f500"]);
    expect(cp.texts.has("f500")).toBe(false);
  });

  test("AC-2 length is the UTF-16 length", () => {
    const cp = takeCheckpoint([f("a", "\u{1F600}"), f("b", "x")], 0, null, { chars: 2 });
    expect(keys(cp)).toEqual(["a"]);
    expect(cp.skipped).toEqual(["b"]);
  });

  test("AC-3 empty input and the empty string", () => {
    const cp = takeCheckpoint([], 5, null);
    expect(cp.at).toBe(5);
    expect(cp.rev).toBeNull();
    expect(cp.texts.size).toBe(0);
    expect(cp.skipped).toEqual([]);
    expect(takeCheckpoint([f("e", "")], 0, null).texts.get("e")).toBe("");
  });
});

describe("sinceCheckpoint", () => {
  test("AC-4.1 the worked example", () => {
    const files = [f("a.ts", "x\n")];
    const current = { "a.ts": "x\ny\n", "b.ts": "new\n" };
    expect(since(files, current, { "b.ts": null })).toEqual([
      { path: "a.ts", status: "M", added: 1, removed: 0 },
      { path: "b.ts", status: "A", added: 1, removed: 0 },
    ]);
    expect(since(files, { "b.ts": "new\n" }, { "a.ts": "x\n", "b.ts": null })).toEqual([
      { path: "b.ts", status: "A", added: 1, removed: 0 },
    ]);
  });

  test("AC-4.2 delete", () => {
    expect(since([f("a", "x\ny\n")], { a: null })).toEqual([{ path: "a", status: "D", added: 0, removed: 2 }]);
  });

  test("AC-4.3 add of a file that was deleted at checkpoint time", () => {
    expect(since([f("c", null)], { c: "q\nr\n" })).toEqual([{ path: "c", status: "A", added: 2, removed: 0 }]);
  });

  test("AC-4.4 modify with both counts", () => {
    expect(since([f("p", "a\nb\nc\n")], { p: "a\nB\nc\nd\n" })).toEqual([
      { path: "p", status: "M", added: 2, removed: 1 },
    ]);
  });

  test("AC-4.5 untracked at checkpoint, changed later", () => {
    expect(since([f("n", "1\n")], { n: "1\n2\n3\n" })).toEqual([{ path: "n", status: "M", added: 2, removed: 0 }]);
  });

  test("AC-4.6 unchanged at checkpoint, changed now", () => {
    expect(since([], { m: "two\n" }, { m: "one\n" })).toEqual([{ path: "m", status: "M", added: 1, removed: 1 }]);
    expect(since([], { m: "two\n" }, { m: null })).toEqual([{ path: "m", status: "A", added: 1, removed: 0 }]);
    expect(since([], { m: null }, { m: "one\ntwo\n" })).toEqual([{ path: "m", status: "D", added: 0, removed: 2 }]);
  });

  test("AC-4.7 a path no longer changed goes back to the base text", () => {
    expect(since([f("k", "edited\n")], {}, { k: "orig\n" })).toEqual([
      { path: "k", status: "M", added: 1, removed: 1 },
    ]);
    expect(since([f("k", "edited\n")], {}, { k: null })).toEqual([{ path: "k", status: "D", added: 0, removed: 1 }]);
  });

  test("AC-4.8 differing only by the final newline is kept with zero counts", () => {
    expect(since([f("t", "x")], { t: "x\n" })).toEqual([{ path: "t", status: "M", added: 0, removed: 0 }]);
  });

  test("AC-4.9 the empty string is not null", () => {
    expect(since([f("e", "")], { e: "x" })).toEqual([{ path: "e", status: "M", added: 1, removed: 0 }]);
    expect(since([f("e", null)], { e: "" })).toEqual([{ path: "e", status: "A", added: 0, removed: 0 }]);
  });

  test("AC-5 leaves out identical, unknown, skipped and reverted paths", () => {
    expect(since([f("x", "x\n")], { x: "x\n" })).toEqual([]);
    expect(since([f("n", null)], { n: null })).toEqual([]);
    expect(since([], { u: "x" }, { u: undefined as unknown as null })).toEqual([]);
    expect(since([f("u", "x")], {}, { u: undefined as unknown as null })).toEqual([]);
    const cp = takeCheckpoint([f("s", "x")], 0, "R", { files: 0 });
    expect(cp.skipped).toEqual(["s"]);
    const never = () => {
      throw new Error("base must not be asked");
    };
    expect(sinceCheckpoint(cp, cur({ s: "anything" }), never)).toEqual([]);
    expect(since([], {}, { z: "whatever" })).toEqual([]);
    expect(since([f("k", "edited\n")], {}, { k: "edited\n" })).toEqual([]);
  });

  test("AC-5 skipping one path never affects the others", () => {
    const cp = takeCheckpoint([f("a", "1"), f("b", "2")], 0, "R", { files: 1 });
    expect(cp.skipped).toEqual(["b"]);
    expect(sinceCheckpoint(cp, cur({ a: "1\n2", b: "q" }), baseOf({})).map((e) => e.path)).toEqual(["a"]);
    expect(since([f("u", "x"), f("v", "1")], { v: "2" }, { u: undefined as unknown as null })).toEqual([
      { path: "v", status: "M", added: 1, removed: 1 },
    ]);
  });

  test("AC-6.1 sorted by plain string comparison", () => {
    const current = { "a/b.ts": "1", "a.ts": "1", "B.ts": "1", "b.ts": "1" };
    const base = { "a/b.ts": null, "a.ts": null, "B.ts": null, "b.ts": null };
    expect(since([], current, base).map((e) => e.path)).toEqual(["B.ts", "a.ts", "a/b.ts", "b.ts"]);
  });

  test("AC-6.2 line splitting", () => {
    expect(since([f("l", "a\n\n")], { l: "a\n" })).toEqual([{ path: "l", status: "M", added: 0, removed: 1 }]);
    expect(since([f("l", "x\n")], { l: "x\nx\n" })).toEqual([{ path: "l", status: "M", added: 1, removed: 0 }]);
    expect(since([f("l", "a\r\n")], { l: "a\n" })).toEqual([{ path: "l", status: "M", added: 1, removed: 1 }]);
  });

  test("AC-6.3 empty inputs", () => {
    expect(sinceCheckpoint(takeCheckpoint([], 0, null), new Map(), () => undefined)).toEqual([]);
  });

  test("AC-6.4 does not mutate its inputs", () => {
    const cp = takeCheckpoint([f("a", "1"), f("b", "2")], 0, "R", { files: 1 });
    const current = cur({ a: "2", c: "3" });
    sinceCheckpoint(cp, current, baseOf({ c: null }));
    expect([...cp.texts.entries()]).toEqual([["a", "1"]]);
    expect(cp.skipped).toEqual(["b"]);
    expect([...current.entries()]).toEqual([["a", "2"], ["c", "3"]]);
  });

  test("AC-6.5 counts add up across hunks", () => {
    expect(since([f("h", "1\n2\n3\n4\n5\n")], { h: "1\nX\n3\n4\nY\nZ\n" })).toEqual([
      { path: "h", status: "M", added: 3, removed: 2 },
    ]);
  });
});
