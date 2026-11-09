import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";
import type { ChangeFile, ChangesData } from "../src/client/api.ts";
import { unreviewedKey, searchKey } from "../src/client/keys.ts";
import { UNREVIEWED_COMMANDS, runUnreviewed } from "../src/client/unreviewed.ts";

describe("unreviewedKey", () => {
  test("Alt+F6 is next, Alt+Shift+F6 is previous", () => {
    expect(unreviewedKey({ key: "F6", altKey: true }, { inTerm: false })).toBe(1);
    expect(unreviewedKey({ key: "F6", altKey: true, shiftKey: true }, { inTerm: false })).toBe(-1);
    expect(unreviewedKey({ key: "F6", code: "F6", altKey: true }, { inTerm: false })).toBe(1);
    expect(unreviewedKey({ key: "F6", code: "F6", altKey: true, shiftKey: true }, { inTerm: false })).toBe(-1);
  });
  test("Ctrl or Meta gives null", () => {
    for (const m of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, metaKey: true }]) {
      expect(unreviewedKey({ key: "F6", altKey: true, ...m }, { inTerm: false })).toBeNull();
      expect(unreviewedKey({ key: "F6", altKey: true, shiftKey: true, ...m }, { inTerm: false })).toBeNull();
    }
  });
  test("never from the terminal", () => {
    expect(unreviewedKey({ key: "F6", altKey: true }, { inTerm: true })).toBeNull();
    expect(unreviewedKey({ key: "F6", altKey: true, shiftKey: true }, { inTerm: true })).toBeNull();
  });
  test("other keys are null and Alt+F5 is untouched", () => {
    expect(unreviewedKey({ key: "F6" }, { inTerm: false })).toBeNull();
    expect(unreviewedKey({ key: "F5", altKey: true }, { inTerm: false })).toBeNull();
    expect(unreviewedKey({ key: "F7", altKey: true }, { inTerm: false })).toBeNull();
    for (const isMac of [true, false]) expect(searchKey({ key: "F5", altKey: true }, { isMac, inTerm: false })).toBeNull();
  });
});

describe("UNREVIEWED_COMMANDS", () => {
  test("exactly the two commands, next first", () => {
    expect(UNREVIEWED_COMMANDS.map((c) => ({ ...c }))).toEqual([
      { id: "changes.nextUnreviewed", title: "Changes: Next Unreviewed File", dir: 1 },
      { id: "changes.prevUnreviewed", title: "Changes: Previous Unreviewed File", dir: -1 },
    ]);
  });
});

function stub(files: string[], step: string | null, count: number) {
  const calls: string[] = [];
  const msgs: string[] = [];
  const view = {
    files: files.map((path) => ({ path })),
    stepUnreviewed: (d: 1 | -1) => (calls.push(`step${d}`), step === null ? null : { path: step }),
    unreviewedCount: () => (calls.push("count"), count),
  };
  return { view, calls, msgs, announce: (m: string) => void msgs.push(m) };
}

describe("runUnreviewed with a stubbed view", () => {
  test("announces path and the count left", () => {
    const s = stub(["a.ts", "b.ts"], "a.ts", 1);
    runUnreviewed(1, s);
    expect(s.msgs).toEqual(["a.ts, 1 unreviewed left"]);
  });
  test("zero left is still spelled out", () => {
    const s = stub(["a.ts", "b.ts"], "a.ts", 0);
    runUnreviewed(-1, s);
    expect(s.msgs).toEqual(["a.ts, 0 unreviewed left"]);
    expect(s.calls[0]).toBe("step-1");
  });
  test("nothing unreviewed: fixed wording without a singular form", () => {
    const s = stub(["a.ts"], null, 0);
    runUnreviewed(1, s);
    expect(s.msgs).toEqual(["All 1 changed files reviewed"]);
  });
  test("an empty list says No changes", () => {
    const s = stub([], null, 0);
    runUnreviewed(1, s);
    expect(s.msgs).toEqual(["No changes"]);
  });
});

describe("runUnreviewed with a real ChangesView", () => {
  let C: typeof import("../src/client/changes.ts");
  let restore: (() => void) | null = null;
  beforeAll(async () => {
    installDom();
    C = await import("../src/client/changes.ts");
  });
  afterAll(() => uninstallDom());
  afterEach(() => {
    restore?.();
    restore = null;
  });

  const f = (path: string): ChangeFile => ({ path, status: "M", added: 1, removed: 0, binary: false });
  const data = (files: ChangeFile[]): ChangesData => ({
    repo: true, scope: "branch", base: { name: "main", oid: "b".repeat(40), mergeBase: "c".repeat(40), same: false }, rev: "c".repeat(40),
    files, truncated: false, commits: 2, subjects: ["feat: one"],
  });

  test("walks a.ts, b.ts, c.ts then reports all reviewed", async () => {
    const m = mockFetch(() => Response.json(data([f("a.ts"), f("b.ts"), f("c.ts")])));
    restore = m.restore;
    const v = new C.ChangesView({ debounce: 0 });
    v.setRepo(true);
    await v.refresh();
    v.onOpen = (x) => v.setCurrent(x.path);
    const msgs: string[] = [];
    const deps = { view: v, announce: (s: string) => void msgs.push(s) };
    for (let i = 0; i < 4; i++) runUnreviewed(1, deps);
    expect(msgs).toEqual(["a.ts, 2 unreviewed left", "b.ts, 1 unreviewed left", "c.ts, 0 unreviewed left", "All 3 changed files reviewed"]);
    void (null as unknown as FakeElement);
  });
});
