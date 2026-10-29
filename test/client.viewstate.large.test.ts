import { describe, expect, test } from "bun:test";

// Pure mode decisions for Markdown tabs, including the 1 MiB size gate (review SL06 major).
//   viewMode(path, size, truncated, state)    -> "source" | "preview"   what a load shows
//   toggleMode(path, size, truncated, state)  -> next state             what the toggle button / palette does
//   toggleLabel(mode)                         -> "Preview" | "View source"
// state is { asSource: boolean; forcePreview: boolean }.
const V: Record<string, unknown> = (await import("../src/client/viewstate.ts").catch(() => ({}))) as Record<string, unknown>;

type State = { asSource: boolean; forcePreview: boolean };
type Mode = "source" | "preview";
const need = <T>(name: string): T => {
  expect(typeof V[name]).toBe("function");
  return V[name] as T;
};
const viewMode = (p: string, size: number, tr: boolean, s: State) => need<(p: string, size: number, tr: boolean, s: State) => Mode>("viewMode")(p, size, tr, s);
const toggle = (p: string, size: number, tr: boolean, s: State) => need<(p: string, size: number, tr: boolean, s: State) => State>("toggleMode")(p, size, tr, s);
const label = (m: Mode) => need<(m: Mode) => string>("toggleLabel")(m);

const BIG = 1024 * 1024 + 1;
const fresh: State = { asSource: false, forcePreview: false };

describe("a Markdown file over 1 MiB", () => {
  test("opens in source and the toggle is labelled Preview", () => {
    const m = viewMode("big.md", BIG, false, fresh);
    expect(m).toBe("source");
    expect(label(m)).toBe("Preview");
  });

  test("clicking Preview renders the preview and the label becomes View source", () => {
    const s = toggle("big.md", BIG, false, fresh);
    const m = viewMode("big.md", BIG, false, s);
    expect(m).toBe("preview");
    expect(label(m)).toBe("View source");
  });

  test("clicking again returns to source", () => {
    const s1 = toggle("big.md", BIG, false, fresh);
    const s2 = toggle("big.md", BIG, false, s1);
    const m = viewMode("big.md", BIG, false, s2);
    expect(m).toBe("source");
    expect(label(m)).toBe("Preview");
  });

  test("a third click previews again", () => {
    let s = fresh;
    for (let i = 0; i < 3; i++) s = toggle("big.md", BIG, false, s);
    expect(viewMode("big.md", BIG, false, s)).toBe("preview");
  });

  test("a live reload keeps the chosen mode (state is untouched by a load)", () => {
    const previewing = toggle("big.md", BIG, false, fresh);
    expect(viewMode("big.md", BIG + 500, false, previewing)).toBe("preview");
    const back = toggle("big.md", BIG, false, previewing);
    expect(viewMode("big.md", BIG + 500, false, back)).toBe("source");
  });

  test("a truncated large file behaves the same", () => {
    expect(viewMode("big.md", 8 * 1024 * 1024, true, fresh)).toBe("source");
    expect(viewMode("big.md", 8 * 1024 * 1024, true, toggle("big.md", 8 * 1024 * 1024, true, fresh))).toBe("preview");
  });
});

describe("small Markdown files and other files are unchanged", () => {
  test("a small file previews by default, toggles to source and back", () => {
    expect(viewMode("a.md", 100, false, fresh)).toBe("preview");
    const s1 = toggle("a.md", 100, false, fresh);
    expect(viewMode("a.md", 100, false, s1)).toBe("source");
    expect(label("source")).toBe("Preview");
    expect(label("preview")).toBe("View source");
    expect(viewMode("a.md", 100, false, toggle("a.md", 100, false, s1))).toBe("preview");
  });

  test("exactly 1 MiB still previews", () => {
    expect(viewMode("a.md", 1024 * 1024, false, fresh)).toBe("preview");
  });

  test("a file that grows past the cap while previewed (not forced) drops to source; a forced one stays", () => {
    expect(viewMode("a.md", BIG, false, fresh)).toBe("source");
    expect(viewMode("a.md", BIG, false, { asSource: false, forcePreview: true })).toBe("preview");
  });

  test("a file that shrinks under the cap previews again after having been forced or not", () => {
    expect(viewMode("a.md", 10, false, { asSource: false, forcePreview: true })).toBe("preview");
    expect(viewMode("a.md", 10, false, { asSource: true, forcePreview: true })).toBe("source");
  });

  test("non-Markdown text is always source, whatever the size", () => {
    expect(viewMode("a.ts", 10, false, fresh)).toBe("source");
    expect(viewMode("a.md.txt", BIG, false, fresh)).toBe("source");
  });

  test("toggleMode does not mutate its input", () => {
    const s: State = { asSource: false, forcePreview: false };
    toggle("big.md", BIG, false, s);
    expect(s).toEqual({ asSource: false, forcePreview: false });
  });
});
