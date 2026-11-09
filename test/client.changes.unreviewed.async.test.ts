import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom } from "./helpers/fakedom.ts";
import type { ChangeFile, ChangesData } from "../src/client/api.ts";

let C: typeof import("../src/client/changes.ts");
let U: typeof import("../src/client/unreviewed.ts");
beforeAll(async () => {
  installDom();
  C = await import("../src/client/changes.ts");
  U = await import("../src/client/unreviewed.ts");
});
afterAll(() => uninstallDom());

const f = (path: string): ChangeFile => ({ path, status: "M", added: 1, removed: 0, binary: false });
const data = (files: ChangeFile[]): ChangesData => ({
  repo: true, scope: "branch", base: { name: "main", oid: "b".repeat(40), mergeBase: "c".repeat(40), same: false }, rev: "c".repeat(40),
  files, truncated: false, commits: 2, subjects: ["feat: one"],
});

describe("runUnreviewed when the diff opens later (onOpen never calls setCurrent)", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });
  async function make() {
    const m = mockFetch(() => Response.json(data([f("a.ts"), f("b.ts"), f("c.ts")])));
    restore = m.restore;
    const v = new C.ChangesView({ debounce: 0 });
    v.setRepo(true);
    await v.refresh();
    v.onOpen = () => {};
    return v;
  }

  test("the command announces how many are left", async () => {
    const v = await make();
    const said: string[] = [];
    const announce = (m: string) => said.push(m);
    U.runUnreviewed(1, { view: v, announce });
    U.runUnreviewed(1, { view: v, announce });
    U.runUnreviewed(1, { view: v, announce });
    U.runUnreviewed(1, { view: v, announce });
    expect(said).toEqual(["a.ts, 2 unreviewed left", "b.ts, 1 unreviewed left", "c.ts, 0 unreviewed left", "All 3 changed files reviewed"]);
  });
});

describe("liveAnnouncer", () => {
  test("clears the region before setting the text, so a repeated message is announced again", () => {
    const writes: (string | null)[] = [];
    let text: string | null = "";
    const el = {
      get textContent() { return text; },
      set textContent(v: string | null) { writes.push(v); text = v; },
    };
    const say = U.liveAnnouncer(el);
    say("a.ts, 1 unreviewed left");
    say("a.ts, 1 unreviewed left");
    expect(text).toBe("a.ts, 1 unreviewed left");
    expect(writes).toEqual(["", "a.ts, 1 unreviewed left", "", "a.ts, 1 unreviewed left"]);
  });
});
