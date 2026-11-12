import { afterAll, beforeAll, expect, test } from "bun:test";
import { uninstallDom } from "./helpers/fakedom.ts";
import { loadCodeView, mount, type Env } from "./helpers/selfake.ts";

// Gutter diff against HEAD: counts for a one-newline file, and where Next Change lands.

let env: Env;
beforeAll(async () => {
  env = await loadCodeView();
});
afterAll(() => uninstallDom());

const base = Array.from({ length: 30 }, (_, i) => "l" + i);

test("a file that is one newline, identical at HEAD, has no changes", () => {
  const m = mount(env, "\n");
  m.view.setGit("\n", false);
  expect(m.view.gitStats).toEqual({ added: 0, removed: 0 });
});

test("Next Change on a fresh view lands on a change in the first visible line", () => {
  const cur = base.slice();
  cur[0] = "X";
  cur[20] = "Y";
  const m = mount(env, cur.join("\n"));
  m.view.setGit(base.join("\n"), false);
  const seen: number[] = [];
  m.view.onActiveLine = (n: number) => void seen.push(n);
  m.view.nextChange(1);
  expect(seen.at(-1)).toBe(0);
  m.view.nextChange(1);
  expect(seen.at(-1)).toBe(20);
  m.view.nextChange(1);
  expect(seen.at(-1)).toBe(0); // wraps
});

test("Next Change lands on the line that carries a deletion's marker, so Peek works there", () => {
  const cur = base.slice();
  cur.splice(10, 1); // l10 deleted: the marker sits below line index 9
  const m = mount(env, cur.join("\n"));
  m.view.setGit(base.join("\n"), false);
  const seen: number[] = [];
  m.view.onActiveLine = (n: number) => void seen.push(n);
  m.view.setActiveLine(3);
  m.view.nextChange(1);
  expect(seen.at(-1)).toBe(9);
  // Peek opens only on a marked line (the fake DOM cannot build the peek box itself).
  expect((m.view as unknown as { gitMarks: Uint8Array }).gitMarks[9]).toBeGreaterThan(0);
  expect((m.view as unknown as { gitMarks: Uint8Array }).gitMarks[10]).toBe(0);
});
