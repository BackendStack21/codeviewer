import { afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { GitState, relativeTime, type GitStatus } from "../src/client/git.ts";

const st = (files: Record<string, string>, repo = true): GitStatus => ({ repo, branch: "main", detached: false, oid: null, upstream: null, ahead: 0, behind: 0, state: null, stash: 0, files, head: null });

describe("GitState", () => {
  test("describes status codes", () => {
    const g = new GitState();
    g.set(st({ "a.ts": ".M", "b.ts": "M.", "c.ts": "AM", "d.ts": ".D", "A.ts": "A.", "e.ts": "R.", "f.ts": "UU", "g.ts": "??", "h.ts": "!!", "i.ts": ".T" }));
    expect(g.repo).toBe(true);
    expect(g.file("a.ts")).toEqual({ letter: "M", label: "Modified", xy: ".M" });
    expect(g.file("b.ts")).toMatchObject({ letter: "M", label: "Modified (staged)" });
    expect(g.file("c.ts")).toMatchObject({ letter: "M", label: "Added (staged), modified" });
    expect(g.file("d.ts")?.letter).toBe("D");
    expect(g.file("A.ts")?.letter).toBe("A");
    expect(g.file("e.ts")).toMatchObject({ letter: "R", label: "Renamed (staged)" });
    expect(g.file("f.ts")).toMatchObject({ letter: "C", label: "Conflict" });
    expect(g.file("g.ts")).toMatchObject({ letter: "U", label: "Untracked" });
    expect(g.file("h.ts")).toMatchObject({ letter: "I", label: "Ignored" });
    expect(g.file("i.ts")).toMatchObject({ letter: "M", label: "Type changed" });
    expect(g.file("none.ts")).toBeNull();
  });

  test("counts exclude ignored; staged counts index entries only", () => {
    const g = new GitState();
    g.set(st({ "a": ".M", "b": "M.", "c": "AM", "d": "??", "e": "!!", "f": "UU" }));
    expect(g.counts).toEqual({ changed: 3, staged: 2, untracked: 1, conflicts: 1 });
  });

  test("directories take the strongest status inside; prefixes cover descendants", () => {
    const g = new GitState();
    g.set(st({ "src/a/x.ts": ".M", "src/a/y.ts": "??", "src/b/z.ts": "UU", "build/": "!!", "tmp/": "??" }));
    expect(g.dir("src/a")).toBe("M");
    expect(g.dir("src")).toBe("C");
    expect(g.dir("src/b")).toBe("C");
    expect(g.dir("build")).toBe("I");
    expect(g.dir("build/deep/inner")).toBe("I");
    expect(g.dir("tmp")).toBe("U");
    expect(g.dir("other")).toBeNull();
    expect(g.file("build/out.js")?.letter).toBe("I");
    expect(g.file("tmp/a/b.txt")?.letter).toBe("U");
    expect(g.file("src/a/x.ts")?.letter).toBe("M");
    expect(g.file("builder/x")).toBeNull();
  });

  test("changedFiles sorted by priority then path, ignored excluded, prefixes keep trailing slash", () => {
    const g = new GitState();
    g.set(st({ "z.ts": ".M", "a.ts": ".M", "c.ts": "UU", "new/": "??", "ign/": "!!", "d.ts": ".D" }));
    expect(g.changedFiles().map((f) => f.path)).toEqual(["c.ts", "d.ts", "a.ts", "z.ts", "new/"]);
  });

  test("NFD paths match NFC status entries", () => {
    const g = new GitState();
    g.set(st({ "café.ts": ".M" }));
    expect(g.file("café.ts")?.letter).toBe("M");
  });

  test("cleared: changed -> clean/ignored", () => {
    const g = new GitState();
    g.set(st({ "a.ts": ".M", "b.ts": ".M", "dir/": "??" }));
    g.set(st({ "b.ts": ".M" }));
    expect(g.cleared("a.ts")).toBe(true);
    expect(g.cleared("b.ts")).toBe(false);
    expect(g.cleared("dir/f.txt")).toBe(true);
    expect(g.cleared("never.ts")).toBe(false);
    g.set(st({ "b.ts": ".M" }));
    expect(g.cleared("a.ts")).toBe(false);
  });

  test("onChange fires on set; missing files map tolerated", () => {
    const g = new GitState();
    let n = 0;
    g.onChange(() => n++);
    g.set(st({}));
    g.set({ repo: false } as GitStatus);
    expect(n).toBe(2);
    expect(g.repo).toBe(false);
    expect(g.changedFiles()).toEqual([]);
  });
});

describe("relativeTime", () => {
  const NOW = 1_700_000_000_000;
  beforeAll(() => setSystemTime(new Date(NOW)));
  afterEach(() => setSystemTime(new Date(NOW)));
  test("buckets", () => {
    const ago = (s: number) => relativeTime(NOW - s * 1000);
    expect(ago(5)).toBe("just now");
    expect(ago(60)).toBe("1 minute ago");
    expect(ago(150)).toBe("3 minutes ago");
    expect(ago(3600)).toBe("1 hour ago");
    expect(ago(5 * 3600)).toBe("5 hours ago");
    expect(ago(86400)).toBe("1 day ago");
    expect(ago(3 * 86400)).toBe("3 days ago");
    expect(ago(14 * 86400)).toBe("2 weeks ago");
    expect(ago(90 * 86400)).toBe("3 months ago");
    expect(ago(800 * 86400)).toBe("2 years ago");
  });
});
