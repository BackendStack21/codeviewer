import { describe, expect, test } from "bun:test";
import type { ChangeFile } from "../src/client/api.ts";
import type { PickItem } from "../src/client/palette.ts";
import { CHECKPOINT_COMMANDS, CheckpointController, hhmm, type CheckpointDeps, type SinceDiff } from "../src/client/checkpointctl.ts";

const T0705 = new Date(2026, 10, 9, 7, 5).getTime();

const file = (path: string, status: ChangeFile["status"] = "M", extra: Partial<ChangeFile> = {}): ChangeFile => ({
  path,
  status,
  added: null,
  removed: null,
  binary: false,
  ...extra,
});

interface World {
  rev: string | null;
  repo: boolean;
  files: ChangeFile[];
  /** Current texts; a missing key reads as undefined (unreadable). */
  texts: Record<string, string | null>;
  /** Texts at a revision, keyed `${rev}:${path}`; a missing key reads as undefined. */
  base: Record<string, string | null>;
  clock: number;
}

function setup(init: Partial<World> = {}) {
  const w: World = { rev: "R", repo: true, files: [], texts: {}, base: {}, clock: T0705, ...init };
  const log = {
    changes: 0,
    now: 0,
    reads: [] as string[],
    bases: [] as [string, string][],
    toasts: [] as string[],
    picks: [] as { items: PickItem[]; title: string }[],
    opened: [] as SinceDiff[],
  };
  let changesImpl: () => Promise<{ repo: boolean; rev: string | null; files: ChangeFile[] }> = async () => ({ repo: w.repo, rev: w.rev, files: w.files });
  const deps: CheckpointDeps = {
    changes: () => {
      log.changes++;
      return changesImpl();
    },
    readText: async (p) => {
      log.reads.push(p);
      return p in w.texts ? w.texts[p] : undefined;
    },
    baseText: async (p, rev) => {
      log.bases.push([p, rev]);
      const k = `${rev}:${p}`;
      return k in w.base ? w.base[k] : undefined;
    },
    now: () => {
      log.now++;
      return w.clock;
    },
    notify: (m) => void log.toasts.push(m),
    pick: (items, title) => void log.picks.push({ items, title }),
    openDiff: (d) => void log.opened.push(d),
  };
  const ctl = new CheckpointController(deps);
  return { ctl, w, log, setChanges: (f: typeof changesImpl) => (changesImpl = f) };
}

const entries = (ctl: CheckpointController) => [...(ctl.checkpoint?.texts.entries() ?? [])];

describe("AC-7 command table and hhmm", () => {
  test("the three commands, in order", () => {
    expect(CHECKPOINT_COMMANDS.map((c) => ({ ...c }))).toEqual([
      { id: "changes.checkpoint", title: "Changes: Set Checkpoint" },
      { id: "changes.sinceCheckpoint", title: "Changes: Since Checkpoint\u2026" },
      { id: "changes.clearCheckpoint", title: "Changes: Clear Checkpoint" },
    ]);
  });
  test("hhmm is local, 24-hour and zero padded", () => {
    expect(hhmm(new Date(2026, 10, 9, 7, 5).getTime())).toBe("07:05");
    expect(hhmm(new Date(2026, 10, 9, 23, 59).getTime())).toBe("23:59");
    expect(hhmm(new Date(2026, 10, 9, 0, 0).getTime())).toBe("00:00");
  });
});

describe("AC-8 set", () => {
  test("worked example: renames, deletes, binary and unreadable files", async () => {
    const { ctl, log } = setup({
      files: [
        file("a.ts"),
        file("img.png", "M", { binary: true }),
        file("gone.ts", "D"),
        file("new.ts", "R", { oldPath: "old.ts" }),
        file("big.ts"),
      ],
      texts: { "a.ts": "x\n", "new.ts": "n\n" },
    });
    await ctl.set();
    expect(entries(ctl)).toEqual([["a.ts", "x\n"], ["gone.ts", null], ["old.ts", null], ["new.ts", "n\n"]]);
    expect(ctl.checkpoint?.skipped).toEqual(["img.png", "big.ts"]);
    expect(ctl.checkpoint?.rev).toBe("R");
    expect(ctl.checkpoint?.at).toBe(T0705);
    expect(log.toasts).toEqual(["Checkpoint set (4 files, 2 skipped)"]);
  });

  test("calls changes and now once; never reads a binary or deleted file", async () => {
    const { ctl, log } = setup({
      files: [file("a.ts"), file("b.bin", "M", { binary: true }), file("c.ts", "D"), file("u.ts", "?")],
      texts: { "a.ts": "a", "u.ts": "u" },
    });
    await ctl.set();
    expect(log.changes).toBe(1);
    expect(log.now).toBe(1);
    expect(log.reads.sort()).toEqual(["a.ts", "u.ts"]);
  });

  test("a rename whose old path is itself listed does not add the old path twice", async () => {
    const { ctl } = setup({
      files: [file("old.ts", "D"), file("new.ts", "R", { oldPath: "old.ts" })],
      texts: { "new.ts": "n" },
    });
    await ctl.set();
    expect(entries(ctl)).toEqual([["old.ts", null], ["new.ts", "n"]]);
  });

  test("toast forms: no plural, empty listing, nothing skipped", async () => {
    const one = setup({ files: [file("a.ts")], texts: { "a.ts": "x" } });
    await one.ctl.set();
    expect(one.log.toasts).toEqual(["Checkpoint set (1 files)"]);
    const none = setup({ files: [] });
    await none.ctl.set();
    expect(none.log.toasts).toEqual(["Checkpoint set (0 files)"]);
    expect(none.ctl.checkpoint?.texts.size).toBe(0);
  });

  test("a second set replaces the first", async () => {
    const { ctl, w } = setup({ files: [file("a.ts")], texts: { "a.ts": "1", "b.ts": "2" } });
    await ctl.set();
    const first = ctl.checkpoint;
    expect(first).not.toBeNull();
    w.files = [file("b.ts")];
    await ctl.set();
    expect(ctl.checkpoint).not.toBe(first);
    expect(entries(ctl)).toEqual([["b.ts", "2"]]);
  });

  test("a failing listing keeps the old checkpoint and says so", async () => {
    const { ctl, log, setChanges } = setup({ files: [file("a.ts")], texts: { "a.ts": "1" } });
    await ctl.set();
    const cp = ctl.checkpoint;
    expect(cp).not.toBeNull();
    setChanges(async () => {
      throw new Error("boom");
    });
    await ctl.set();
    expect(ctl.checkpoint).toBe(cp);
    expect(log.toasts.at(-1)).toBe("Could not read the changes");
  });

  test("not a repository keeps the old checkpoint and says so", async () => {
    const { ctl, log, w } = setup({ files: [file("a.ts")], texts: { "a.ts": "1" } });
    await ctl.set();
    const cp = ctl.checkpoint;
    w.repo = false;
    await ctl.set();
    expect(ctl.checkpoint).toBe(cp);
    expect(log.toasts.at(-1)).toBe("Not a git repository");
  });

  test("a set superseded by a later set drops its result silently", async () => {
    const { ctl, log, setChanges, w } = setup({ texts: { "slow.ts": "s", "fast.ts": "f" } });
    let release: (v: { repo: boolean; rev: string | null; files: ChangeFile[] }) => void = () => {};
    setChanges(() => new Promise((r) => (release = r)));
    const first = ctl.set();
    setChanges(async () => ({ repo: true, rev: w.rev, files: [file("fast.ts")] }));
    await ctl.set();
    release({ repo: true, rev: "R", files: [file("slow.ts")] });
    await first;
    expect(entries(ctl)).toEqual([["fast.ts", "f"]]);
    expect(log.toasts).toEqual(["Checkpoint set (1 files)"]);
  });

  test("the cap-skip path works end to end: 501 files give 500 stored and 1 skipped", async () => {
    const files: ChangeFile[] = [];
    const texts: Record<string, string> = {};
    for (let i = 0; i <= 500; i++) {
      files.push(file(`f${i}`));
      texts[`f${i}`] = "x";
    }
    const { ctl, log } = setup({ files, texts });
    await ctl.set();
    expect(ctl.checkpoint?.texts.size).toBe(500);
    expect(ctl.checkpoint?.skipped).toEqual(["f500"]);
    expect(log.toasts).toEqual(["Checkpoint set (500 files, 1 skipped)"]);
  });

  test("cap-skipped paths come before unreadable ones", async () => {
    const files: ChangeFile[] = [file("unreadable.ts")];
    const texts: Record<string, string> = {};
    for (let i = 0; i <= 500; i++) {
      files.push(file(`f${i}`));
      texts[`f${i}`] = "x";
    }
    const { ctl } = setup({ files, texts });
    await ctl.set();
    expect(ctl.checkpoint?.skipped).toEqual(["f500", "unreadable.ts"]);
  });
});

describe("AC-9 no checkpoint and clear", () => {
  test("since with no checkpoint only toasts", async () => {
    const { ctl, log } = setup({ files: [file("a.ts")], texts: { "a.ts": "x" } });
    await ctl.since();
    expect(log.toasts).toEqual(["No checkpoint set"]);
    expect(log.changes).toBe(0);
    expect(log.reads).toEqual([]);
    expect(log.bases).toEqual([]);
    expect(log.picks).toEqual([]);
    expect(log.opened).toEqual([]);
  });

  test("clear forgets the checkpoint and toasts, also when none was set", async () => {
    const { ctl, log } = setup({ files: [file("a.ts")], texts: { "a.ts": "x" } });
    ctl.clear();
    expect(log.toasts).toEqual(["Checkpoint cleared"]);
    await ctl.set();
    expect(ctl.checkpoint).not.toBeNull();
    ctl.clear();
    expect(ctl.checkpoint).toBeNull();
    expect(log.toasts.at(-1)).toBe("Checkpoint cleared");
    await ctl.since();
    expect(log.toasts.at(-1)).toBe("No checkpoint set");
  });
});

describe("AC-10 since with nothing", () => {
  test("nothing changed since the checkpoint", async () => {
    const { ctl, log } = setup({ files: [file("a.ts")], texts: { "a.ts": "x\n" } });
    await ctl.set();
    await ctl.since();
    expect(log.toasts.at(-1)).toBe("Nothing changed since the checkpoint (07:05)");
    expect(log.picks).toEqual([]);
  });

  test("a failing listing or a non repository keeps the checkpoint", async () => {
    const { ctl, log, setChanges, w } = setup({ files: [file("a.ts")], texts: { "a.ts": "x\n" } });
    await ctl.set();
    const cp = ctl.checkpoint;
    expect(cp).not.toBeNull();
    setChanges(async () => {
      throw new Error("boom");
    });
    await ctl.since();
    expect(log.toasts.at(-1)).toBe("Could not read the changes");
    expect(ctl.checkpoint).toBe(cp);
    setChanges(async () => ({ repo: false, rev: w.rev, files: [] }));
    await ctl.since();
    expect(log.toasts.at(-1)).toBe("Not a git repository");
    expect(ctl.checkpoint).toBe(cp);
    expect(log.picks).toEqual([]);
  });
});

/** The worked example of AC-12: a checkpoint at 07:05 holding a.ts, then a.ts edited and b.ts added. */
async function worked() {
  const s = setup({ files: [file("a.ts")], texts: { "a.ts": "x\n" } });
  await s.ctl.set();
  s.w.rev = "R2";
  s.w.files = [file("a.ts"), file("b.ts", "?")];
  s.w.texts = { "a.ts": "x\ny\n", "b.ts": "new\n" };
  s.w.base = { "R:b.ts": null };
  s.log.toasts.length = 0;
  s.log.reads.length = 0;
  s.log.bases.length = 0;
  return s;
}

describe("AC-11 pick list", () => {
  test("title, labels, details and badges", async () => {
    const { ctl, log } = await worked();
    await ctl.since();
    expect(log.picks.length).toBe(1);
    const { items, title } = log.picks[0]!;
    expect(title).toBe("Changes since 07:05: 2 files, type to filter");
    expect(items.map((i) => i.label)).toEqual(["a.ts", "b.ts"]);
    expect(items.map((i) => i.detail)).toEqual(["+1 \u22120", "+1 \u22120"]);
    expect(items.map((i) => i.icon)).toEqual([
      '<span class="gbadge git-M" aria-hidden="true">M</span>',
      '<span class="gbadge git-A" aria-hidden="true">A</span>',
    ]);
  });

  test("one entry says file, not files; +0 and -0 are shown", async () => {
    const w2 = setup({ files: [file("t.ts")], texts: { "t.ts": "x" } });
    await w2.ctl.set();
    w2.w.texts = { "t.ts": "x\n" };
    await w2.ctl.since();
    const pick = w2.log.picks[0];
    expect(pick?.title).toBe("Changes since 07:05: 1 file, type to filter");
    expect(pick?.items[0]?.detail).toBe("+0 \u22120");
  });

  test("raw path text only reaches the label, with hidden characters made visible", async () => {
    const evil = "<img src=x onerror=1>.ts";
    const bidi = "a\u202eb.ts";
    const s = setup({ files: [file(evil, "?"), file(bidi, "?")], texts: { [evil]: "1\n", [bidi]: "2\n" } });
    await s.ctl.set();
    s.w.texts = { [evil]: "1\n2\n", [bidi]: "2\n3\n" };
    await s.ctl.since();
    const items = s.log.picks[0]?.items ?? [];
    expect(items.map((i) => i.label).sort()).toEqual([evil, "a\\u202eb.ts"].sort());
    for (const i of items) {
      expect(i.icon).toMatch(/^<span class="gbadge git-M" aria-hidden="true">M<\/span>$/);
      expect(i.detail).toBe("+1 \u22120");
    }
  });
});

describe("AC-12 how since reads", () => {
  test("worked example reads the base once, with the checkpoint's rev", async () => {
    const { ctl, log } = await worked();
    await ctl.since();
    expect(log.bases).toEqual([["b.ts", "R"]]);
    expect(log.picks[0]?.items.map((i) => i.label)).toEqual(["a.ts", "b.ts"]);
  });

  test("binary and unreadable files are skipped, the stored checkpoint is untouched", async () => {
    const s = setup({ files: [file("a.ts")], texts: { "a.ts": "x\n" } });
    await s.ctl.set();
    const cp = s.ctl.checkpoint;
    const skippedBefore = [...(cp?.skipped ?? [])];
    s.w.files = [file("a.ts"), file("img.png", "M", { binary: true }), file("big.ts")];
    s.w.texts = { "a.ts": "x\ny\n" };
    s.log.reads.length = 0;
    await s.ctl.since();
    expect(s.log.reads).toEqual(["a.ts", "big.ts"]);
    expect(s.log.bases).toEqual([]);
    expect(s.log.picks[0]?.items.map((i) => i.label)).toEqual(["a.ts"]);
    expect(s.ctl.checkpoint).toBe(cp);
    expect(cp?.skipped).toEqual(skippedBefore);
  });

  test("a deleted file is null without a read, and a rename adds old to null", async () => {
    const s = setup({ files: [], texts: {} });
    await s.ctl.set();
    s.w.files = [file("gone.ts", "D"), file("new.ts", "R", { oldPath: "old.ts" })];
    s.w.texts = { "new.ts": "n\n" };
    s.w.base = { "R:gone.ts": "g1\ng2\n", "R:old.ts": "o\n", "R:new.ts": null };
    await s.ctl.since();
    expect(s.log.reads).toEqual(["new.ts"]);
    const items = s.log.picks[0]?.items ?? [];
    expect(items.map((i) => [i.label, i.detail])).toEqual([
      ["gone.ts", "+0 \u22122"],
      ["new.ts", "+1 \u22120"],
      ["old.ts", "+0 \u22121"],
    ]);
    expect(s.log.bases.map((b) => b[1])).toEqual(["R", "R", "R"]);
  });

  test("a path read from the checkpoint and from the listing needs no base", async () => {
    const s = setup({ files: [file("a.ts"), file("b.ts")], texts: { "a.ts": "1\n", "b.ts": "2\n" } });
    await s.ctl.set();
    s.w.files = [file("a.ts")]; // b.ts is no longer changed: needs its base
    s.w.texts = { "a.ts": "1\n1\n" };
    s.w.base = { "R:b.ts": "orig\n" };
    await s.ctl.since();
    expect(s.log.bases).toEqual([["b.ts", "R"]]);
    expect(s.log.picks[0]?.items.map((i) => i.label)).toEqual(["a.ts", "b.ts"]);
  });

  test("the checkpoint's rev is used even after the listing's rev moved", async () => {
    const { ctl, log, w } = await worked();
    expect(w.rev).toBe("R2");
    await ctl.since();
    expect(log.bases.every(([, rev]) => rev === "R")).toBe(true);
    expect(log.bases.length).toBe(1);
  });

  test("with no commit at checkpoint time the base is never read and is null", async () => {
    const s = setup({ rev: null, files: [], texts: {} });
    await s.ctl.set();
    expect(s.ctl.checkpoint?.rev).toBeNull();
    s.w.files = [file("n.ts", "?")];
    s.w.texts = { "n.ts": "1\n" };
    await s.ctl.since();
    expect(s.log.bases).toEqual([]);
    const items = s.log.picks[0]?.items ?? [];
    expect(items.map((i) => [i.label, i.detail])).toEqual([["n.ts", "+1 \u22120"]]);
    expect(items[0]?.icon).toContain("git-A");
  });

  test("an unknown base (undefined) leaves the path out", async () => {
    const s = setup({ files: [], texts: {} });
    await s.ctl.set();
    s.w.files = [file("m.ts"), file("k.ts")];
    s.w.texts = { "m.ts": "1\n", "k.ts": "2\n" };
    s.w.base = { "R:k.ts": "0\n" }; // m.ts base is undefined
    await s.ctl.since();
    expect(s.log.picks[0]?.items.map((i) => i.label)).toEqual(["k.ts"]);
  });

  test("a checkpoint replaced or cleared while reading drops the result silently", async () => {
    const s = await worked();
    let release: (v: string | null) => void = () => {};
    const slow = new Promise<string | null>((r) => (release = r));
    // Rebuild a controller whose baseText is slow, over the same world.
    const log2 = { picks: 0, toasts: [] as string[] };
    const ctl2 = new CheckpointController({
      changes: async () => ({ repo: true, rev: "R2", files: s.w.files }),
      readText: async (p) => s.w.texts[p],
      baseText: () => slow,
      now: () => T0705,
      notify: (m) => void log2.toasts.push(m),
      pick: () => void log2.picks++,
      openDiff: () => {},
    });
    await ctl2.set();
    log2.toasts.length = 0;
    const pending = ctl2.since();
    ctl2.clear();
    release(null);
    await pending;
    expect(log2.picks).toBe(0);
    expect(log2.toasts).toEqual(["Checkpoint cleared"]);
  });
});

describe("AC-13 opening an entry", () => {
  test("Enter opens the texts captured when the list was built", async () => {
    const { ctl, log, w } = await worked();
    await ctl.since();
    expect(log.picks.length).toBe(1);
    const items = log.picks[0]!.items;
    w.texts = { "a.ts": "changed after the list\n", "b.ts": "changed too\n" };
    const readsBefore = log.reads.length;
    items[0]!.run();
    expect(log.opened).toEqual([{ path: "a.ts", status: "M", oldText: "x\n", newText: "x\ny\n", since: "07:05" }]);
    items[1]!.run();
    expect(log.opened[1]).toEqual({ path: "b.ts", status: "A", oldText: null, newText: "new\n", since: "07:05" });
    expect(log.opened.length).toBe(2);
    expect(log.reads.length).toBe(readsBefore);
  });

  test("a path that went back to the base opens its checkpoint text against the base", async () => {
    const s = setup({ files: [file("k.ts")], texts: { "k.ts": "edited\n" } });
    await s.ctl.set();
    s.w.files = [];
    s.w.base = { "R:k.ts": "orig\n" };
    await s.ctl.since();
    expect(s.log.picks.length).toBe(1);
    s.log.picks[0]!.items[0]!.run();
    expect(s.log.opened).toEqual([{ path: "k.ts", status: "M", oldText: "edited\n", newText: "orig\n", since: "07:05" }]);
  });
});
