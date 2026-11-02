// A theme switch must land at once on everything, and "system" must follow macOS in the Mac app.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { nativeThemeMessage, setDocumentTheme } from "../src/client/theme.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** Stands in for <html>: reading offsetHeight is what commits styles, so record the state at that moment. */
function fakeRoot(theme = "dark") {
  const flushes: Array<{ theme?: string; switching: boolean }> = [];
  const dataset: Record<string, string> = { theme };
  const root = {
    dataset,
    get offsetHeight() {
      flushes.push({ theme: dataset.theme, switching: "themeSwitching" in dataset });
      return 0;
    },
  };
  return { root: root as unknown as HTMLElement, dataset, flushes };
}

describe("switching theme", () => {
  test("styles commit with the new theme while transitions are off", () => {
    const { root, flushes } = fakeRoot("dark");
    setDocumentTheme(root, "light");
    expect(flushes).toEqual([{ theme: "light", switching: true }]);
  });

  test("transitions come back afterwards", () => {
    const { root, dataset } = fakeRoot("dark");
    setDocumentTheme(root, "light");
    expect(dataset.theme).toBe("light");
    expect("themeSwitching" in dataset).toBe(false);
  });

  test("the stylesheet turns every transition off during a switch", () => {
    const css = read("src/client/styles.css");
    const rule = /:root\[data-theme-switching\] \*,\s*:root\[data-theme-switching\] \*::before,\s*:root\[data-theme-switching\] \*::after \{\s*transition: none !important;\s*\}/;
    expect(css).toMatch(rule);
  });

  test("the app goes through setDocumentTheme", () => {
    const app = read("src/client/app.ts");
    expect(app).toContain("setDocumentTheme(document.documentElement");
    expect(app).not.toContain("dataset.theme =");
  });
});

describe("the Mac window's appearance", () => {
  test("the page tells the window which mode is chosen", () => {
    expect(nativeThemeMessage("system", true, "#0c0f15")).toEqual({ t: "theme", mode: "system", dark: true, bg: "#0c0f15" });
    expect(nativeThemeMessage("light", false, "#f4f5f8")).toEqual({ t: "theme", mode: "light", dark: false, bg: "#f4f5f8" });
  });

  test("system clears the forced appearance, or prefers-color-scheme only echoes what the page last set", () => {
    const swift = read("packaging/macos/main.swift");
    expect(swift).toMatch(/window\.appearance = body\["mode"\] as\? String == "system" \? nil : NSAppearance\(named: dark \? \.darkAqua : \.aqua\)/);
  });
});
