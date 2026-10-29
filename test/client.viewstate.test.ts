import { describe, expect, test } from "bun:test";

let V: typeof import("../src/client/viewstate.ts");
try {
  V = await import("../src/client/viewstate.ts");
} catch {}

type In = import("../src/client/viewstate.ts").ViewInput;
type Plan = import("../src/client/viewstate.ts").ViewPlan;
const base: In = { kind: "text", path: "a.md", asSource: false, reload: false, hasMd: false, hasCode: false };

/** Applies a load to a tab state, the way the editor must: the plan says what the tab keeps. */
function step(s: { hasMd: boolean; hasCode: boolean }, kind: In["kind"], extra: Partial<In> = {}) {
  const plan = V.planView({ ...base, kind, reload: true, ...s, ...extra });
  return { plan, state: { hasMd: plan.md, hasCode: plan.code } };
}
const none = { hasMd: false, hasCode: false };

describe("planView", () => {
  test("first load of a Markdown file is a fresh preview", () => {
    expect(V.planView(base)).toEqual({ view: "md", reuse: false, md: true, code: false });
  });
  test("live reload of a preview reuses it", () => {
    expect(V.planView({ ...base, reload: true, hasMd: true })).toEqual({ view: "md", reuse: true, md: true, code: false });
  });
  test("Markdown in source mode shows code; reload reuses it only when a CodeView exists", () => {
    expect(V.planView({ ...base, asSource: true })).toEqual({ view: "code", reuse: false, md: false, code: true });
    expect(V.planView({ ...base, asSource: true, reload: true, hasCode: true })).toEqual({ view: "code", reuse: true, md: false, code: true });
    expect(V.planView({ ...base, asSource: true, reload: true, hasCode: false }).reuse).toBe(false);
  });
  test("a stale MarkdownView is dropped when switching to source, and a stale CodeView when previewing", () => {
    expect(V.planView({ ...base, asSource: true, hasMd: true }).md).toBe(false);
    expect(V.planView({ ...base, hasCode: true }).code).toBe(false);
  });
  test("non-Markdown text is code", () => {
    expect(V.planView({ ...base, path: "a.ts" })).toEqual({ view: "code", reuse: false, md: false, code: true });
    expect(V.planView({ ...base, path: "a.md.txt" }).view).toBe("code");
  });
  test.each(["image", "binary", "dir", "error"] as const)("%s keeps neither a MarkdownView nor a CodeView", (kind) => {
    const p: Plan = V.planView({ ...base, kind, reload: true, hasMd: true, hasCode: true });
    expect(p).toEqual({ view: kind, reuse: false, md: false, code: false });
  });
});

describe("stuck sequences (review SL01 major)", () => {
  test("md -> binary -> md shows the preview again, freshly built", () => {
    let s = step(none, "text", { reload: false });
    expect(s.plan.view).toBe("md");
    s = step(s.state, "binary");
    expect(s.state).toEqual(none);
    s = step(s.state, "text");
    expect(s.plan).toEqual({ view: "md", reuse: false, md: true, code: false });
  });
  test("md -> dir -> md shows the preview again, freshly built", () => {
    let s = step(none, "text", { reload: false });
    s = step(s.state, "dir");
    expect(s.state).toEqual(none);
    s = step(s.state, "text");
    expect(s.plan).toEqual({ view: "md", reuse: false, md: true, code: false });
  });
  test("md source -> binary -> md source builds a fresh CodeView", () => {
    let s = step(none, "text", { reload: false, asSource: true });
    s = step(s.state, "binary", { asSource: true });
    s = step(s.state, "text", { asSource: true });
    expect(s.plan).toEqual({ view: "code", reuse: false, md: false, code: true });
  });
});
