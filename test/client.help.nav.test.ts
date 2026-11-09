import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { installDom, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

const root = new URL("..", import.meta.url).pathname;
const read = (rel: string) => readFileSync(root + rel, "utf8");

describe("help sheet lists Go Back and Go Forward (AC-19)", () => {
  let rows: { label: string; key: string }[];
  beforeAll(async () => {
    installDom({ platform: "Linux x86_64" });
    const { Help } = await import("../src/client/help.ts");
    const help = new Help();
    rows = help.el.querySelectorAll<FakeElement>(".kb-row").map((r) => ({
      label: r.querySelector("span")!.textContent,
      key: r.querySelector("kbd")!.textContent,
    }));
  });
  afterAll(() => uninstallDom());

  test("the sheet shows the labels of the platform the module runs as", async () => {
    const { key } = await import("../src/client/util.ts");
    const back = rows.find((r) => /go back/i.test(r.label));
    const fwd = rows.find((r) => /go forward/i.test(r.label));
    expect(back?.key).toBe(key("⌃-", "Ctrl+Alt+-"));
    expect(fwd?.key).toBe(key("⌃⇧-", "Ctrl+Shift+-"));
  });

  test("macOS glyphs are in the source next to the Linux names", () => {
    const src = read("src/client/help.ts");
    expect(src).toMatch(/key\("⌃-", "Ctrl\+Alt\+-"\)/);
    expect(src).toMatch(/key\("⌃⇧-", "Ctrl\+Shift\+-"\)/);
  });
});

describe("docs for back and forward (AC-20, AC-21)", () => {
  test("README key table lists both keys", () => {
    const readme = read("README.md");
    const table = readme.split("\n").filter((l) => l.startsWith("|"));
    expect(table.some((l) => /⌃-/.test(l) && /Ctrl\+Alt\+-/.test(l) && /back/i.test(l))).toBe(true);
    expect(table.some((l) => /⌃⇧-/.test(l) && /Ctrl\+Shift\+-/.test(l) && /forward/i.test(l))).toBe(true);
  });

  test("README feature list mentions back and forward", () => {
    const features = read("README.md").split("\n").filter((l) => l.startsWith("- **"));
    expect(features.some((l) => /back and forward/i.test(l) || /Go Back/.test(l))).toBe(true);
  });

  test("DESIGN.md has the Round 18 section with votes and a findings table", () => {
    const d = read("DESIGN.md");
    const i = d.indexOf("## 27. Round 18: back and forward navigation");
    expect(i).toBeGreaterThan(-1);
    const sec = d.slice(i);
    expect(sec).toMatch(/B7/);
    expect(sec).toMatch(/3 votes/);
    expect(sec).toMatch(/risky-change flags/i);
    expect(sec).toMatch(/checkpoint diff/i);
    expect(sec).toMatch(/\| Finding \| Fix \|/);
    expect(sec).toMatch(/navigation\.ts/);
    expect(sec).toMatch(/routeNavZoomKey/);
    expect(sec).toMatch(/Ctrl\+Alt\+-/);
  });

  test("AGENTS.md layout lists navhistory.ts and navigation.ts", () => {
    const rows = read("AGENTS.md").split("\n").filter((l) => l.startsWith("| `src/client/"));
    expect(rows.some((l) => l.includes("navhistory.ts"))).toBe(true);
    expect(rows.some((l) => l.includes("navigation.ts"))).toBe(true);
  });
});
