import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom } from "./helpers/fakedom.ts";
import type { ChangeFile, ChangesData } from "../src/client/api.ts";

let C: typeof import("../src/client/changes.ts");
beforeAll(async () => {
  installDom();
  C = await import("../src/client/changes.ts");
});
afterAll(() => uninstallDom());

const f = (path: string): ChangeFile => ({ path, status: "M", added: 1, removed: 0, binary: false });
const data = (files: ChangeFile[]): ChangesData => ({
  repo: true, scope: "branch", base: { name: "main", oid: "b".repeat(40), mergeBase: "c".repeat(40), same: false }, rev: "c".repeat(40),
  files, truncated: false, commits: 2, subjects: ["feat: one"],
});

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

test("stepUnreviewed leaves reviewing to opening: with a no-op onOpen nothing becomes reviewed or current", async () => {
  const m = mockFetch(() => Response.json(data([f("a.ts"), f("b.ts"), f("c.ts")])));
  restore = m.restore;
  const v = new C.ChangesView({ debounce: 0 });
  v.setRepo(true);
  await v.refresh();
  const opened: string[] = [];
  v.onOpen = (x) => void opened.push(x.path);
  expect(v.stepUnreviewed(1)?.path).toBe("a.ts");
  expect(opened).toEqual(["a.ts"]);
  expect(v.unreviewedCount()).toBe(3);
  expect(v.position()).toBeNull(); // no file is current
  expect(v.stepUnreviewed(1)?.path).toBe("a.ts"); // still the first unreviewed one
  v.setCurrent("a.ts"); // what the app does once the diff has loaded
  expect(v.unreviewedCount()).toBe(2);
  expect(v.stepUnreviewed(1)?.path).toBe("b.ts");
  expect(v.unreviewedCount()).toBe(2);
});
