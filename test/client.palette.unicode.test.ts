import { afterAll, beforeAll, expect, test } from "bun:test";
import { installDom, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let P: typeof import("../src/client/palette.ts");
beforeAll(async () => {
  installDom();
  P = await import("../src/client/palette.ts");
});
afterAll(() => uninstallDom());

test("match positions index the original string when lower-casing changes its length", () => {
  // "İ" (capital I with dot) lower-cases to two code units: every later position shifted by one.
  const s = "İstanbul/map.ts";
  const m = P.fuzzy("map", s)!;
  expect(m.pos.map((i) => s[i]).join("")).toBe("map");
});

test("the highlight never splits a character outside the BMP into two halves", () => {
  const p = new P.Palette();
  const priv = p as unknown as { files: string[]; lower: string[]; stale: boolean; list: FakeElement };
  priv.files = ["docs/\u{1F600}notes.md", "İstanbul/map.ts"];
  priv.lower = priv.files.map((x) => P.lowerSameLength(x));
  priv.stale = false;
  p.open("\u{1F600}");
  expect(priv.list.innerHTML).toContain("<b>\u{1F600}</b>notes.md");
  p.open("map");
  expect(priv.list.innerHTML).toContain("<b>m</b><b>a</b><b>p</b>.ts");
});
