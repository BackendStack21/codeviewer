import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";
import type { ChangeFile, ChangesData } from "../src/client/api.ts";

let C: typeof import("../src/client/changes.ts");
beforeAll(async () => {
  installDom();
  C = await import("../src/client/changes.ts");
});
afterAll(() => uninstallDom());

const f = (path: string, extra: Partial<ChangeFile> = {}): ChangeFile => ({
  path, status: "M", added: 1, removed: 0, binary: false, ...extra,
});
const flagged = (path: string) => f(path, { oldMode: "100644", newMode: "100755" });
const data = (files: ChangeFile[]): ChangesData => ({
  repo: true, scope: "branch", base: { name: "main", oid: "b".repeat(40), mergeBase: "c".repeat(40), same: false }, rev: "c".repeat(40),
  files, truncated: false, commits: 2, subjects: ["feat: one", "fix: two"],
});

describe("Part B: ch-riskcount keeps its identity across renders", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  // The server answer is swapped between refreshes; a number is an HTTP error.
  function make() {
    let answer: ChangesData | number = data([]);
    const m = mockFetch(() => (typeof answer === "number" ? new Response("{}", { status: answer }) : Response.json(answer)));
    restore = m.restore;
    const v = new C.ChangesView({ debounce: 0 });
    const el = v.el as unknown as FakeElement;
    const summary = el.querySelector(".ch-summary-wrap")!;
    v.setRepo(true);
    return {
      v, summary,
      show: async (a: ChangesData | number) => {
        answer = a;
        await v.refresh();
      },
      risk: () => summary.querySelector(".ch-riskcount"),
    };
  }

  test("the same element object survives a different flagged count, zero and back", async () => {
    const t = make();
    await t.show(data([flagged("a.sh"), flagged("b.sh"), f("plain.txt")]));
    const ref = t.risk()!;
    expect(ref).not.toBeNull();
    expect(ref.textContent).toBe("· 2 flagged");
    expect(ref.getAttribute("role")).toBe("status");
    expect(ref.classList.contains("ch-riskcount")).toBe(true);

    await t.show(data([flagged("a.sh"), f("plain.txt")]));
    expect(t.risk()).toBe(ref);
    expect(t.summary.contains(ref)).toBe(true);
    expect(ref.textContent).toBe("· 1 flagged");

    await t.show(data([f("plain.txt")]));
    expect(t.risk()).toBe(ref);
    expect(ref.textContent).toBe("");

    await t.show(data([flagged("a.sh"), flagged("b.sh")]));
    expect(t.risk()).toBe(ref);
    expect(t.summary.contains(ref)).toBe(true);
    expect(ref.textContent).toBe("· 2 flagged");
    expect(ref.getAttribute("role")).toBe("status");
    expect(ref.classList.contains("ch-riskcount")).toBe(true);
  });

  test("the same element object survives the error, not-a-repository and loading states", async () => {
    const t = make();
    await t.show(data([flagged("a.sh")]));
    const ref = t.risk()!;
    expect(ref).not.toBeNull();

    await t.show(500);
    expect(t.summary.hidden).toBe(true);
    await t.show(data([flagged("a.sh"), flagged("b.sh")]));
    expect(t.risk()).toBe(ref);
    expect(ref.textContent).toBe("· 2 flagged");

    t.v.setRepo(false);
    expect(t.summary.hidden).toBe(true);
    t.v.setRepo(true);
    await t.v.refresh();
    expect(t.risk()).toBe(ref);
    expect(ref.textContent).toBe("· 2 flagged");
  });

  test("a scope switch re-render keeps the same element", async () => {
    const t = make();
    await t.show(data([flagged("a.sh"), f("plain.txt")]));
    const ref = t.risk()!;
    expect(ref).not.toBeNull();
    expect(ref.textContent).toBe("· 1 flagged");
    t.v.setScope("head");
    await t.v.refresh();
    expect(t.risk()).toBe(ref);
    expect(t.summary.contains(ref)).toBe(true);
    expect(ref.textContent).toBe("· 1 flagged");
  });
});
