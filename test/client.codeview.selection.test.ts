import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FakeEvent, uninstallDom } from "./helpers/fakedom.ts";
import { copyEvent, el, fireSelectionChange, loadCodeView, mount, pressDoc, rng, rowOf, scrollTo, text, type Env } from "./helpers/selfake.ts";

let env: Env;
beforeAll(async () => {
  env = await loadCodeView();
});
afterAll(() => uninstallDom());
beforeEach(() => {
  expect(typeof env.C.CodeView).toBe("function");
});

const body = Array.from({ length: 1000 }, (_, i) => `line ${i} text`).join("\n");
const small = ["abcdefgh", "ijklmnop", "qrstuvwx"].join("\n");
const keyA = (init: Record<string, unknown>) => new FakeEvent("keydown", { key: "a", ...init });
const outside = () => el("sidebar", text("elsewhere"));

describe("model copy (AC-2, AC-3)", () => {
  test("setRange stores a normalised range", () => {
    const m = mount(env, small);
    m.view.setRange(rng(2, 3, 0, 1));
    expect(m.view.selection).toEqual(rng(0, 1, 2, 3));
  });

  test("copy writes the full model text of a range reaching far outside the window, and is prevented", () => {
    const m = mount(env, body);
    m.view.setRange(rng(0, 0, 900, 4));
    const want = body.split("\n").slice(0, 901);
    want[900] = want[900]!.slice(0, 4);
    const { e, set } = copyEvent();
    m.scroller.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(set).toEqual([["text/plain", want.join("\n")]]);
    const t = set[0]![1];
    expect(t).not.toContain("more characters");
    expect(t.split("\n")[5]).toBe("line 5 text"); // no gutter number prefix
  });

  test("a partial range copies tabs and newlines exactly", () => {
    const m = mount(env, "a\n\tb\nc");
    m.view.setRange(rng(0, 1, 2, 1));
    const { e, set } = copyEvent();
    m.scroller.dispatchEvent(e);
    expect(set).toEqual([["text/plain", "\n\tb\nc"]]);
  });

  test("the blame label text never reaches the copy", () => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 0, 2, 8));
    m.view.setBlame(1, "BLAMEMARK Someone");
    env.flush();
    const { e, set } = copyEvent();
    m.scroller.dispatchEvent(e);
    expect(set).toEqual([["text/plain", small]]);
  });

  test("a truncated long line copies in full and the label is created as .trunc", () => {
    const long = "x".repeat(5000);
    const src = `short\n${long}\nend`;
    const m = mount(env, src);
    m.view.setRange(rng(0, 2, 2, 2));
    env.flush();
    const { e, set } = copyEvent();
    m.scroller.dispatchEvent(e);
    expect(set).toEqual([["text/plain", `ort\n${long}\nen`]]);
    expect(set[0]![1]).not.toContain("more characters");
    expect(m.html()).toContain('<span class="trunc">');
  });

  test("selectedText mirrors the model text; empty without a range", () => {
    const m = mount(env, small);
    expect(m.view.selectedText()).toBe("");
    m.view.setRange(rng(0, 2, 1, 3));
    expect(m.view.selectedText()).toBe("cdefgh\nijk");
  });

  test("copy without a range is left to the browser", () => {
    const m = mount(env, small);
    const { e, set } = copyEvent();
    m.scroller.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(set).toEqual([]);
  });
});

describe("range survives re-renders (AC-4)", () => {
  test("scrolling the range out of and back into the window keeps it and restores the DOM selection", () => {
    const m = mount(env, body);
    m.view.setRange(rng(10, 2, 300, 4));
    env.flush();
    expect(m.calls.length).toBeGreaterThan(0);
    scrollTo(env, m, 4800); // window ~260..390: line 10 is out, 300 is in
    expect(m.view.selection).toEqual(rng(10, 2, 300, 4));
    let last = m.calls[m.calls.length - 1]!;
    expect(rowOf(last.a)).toBeGreaterThanOrEqual(260);
    expect(last.ao).toBe(0);
    expect(rowOf(last.f)).toBe(300);
    expect(last.fo).toBe(2);
    scrollTo(env, m, 0);
    expect(m.view.selection).toEqual(rng(10, 2, 300, 4));
    last = m.calls[m.calls.length - 1]!;
    expect(rowOf(last.a)).toBe(10);
    expect(last.ao).toBe(2);
    expect(rowOf(last.f)).toBeLessThan(300); // 300 is now past the window; only the visible part is applied
  });

  test("a range wholly outside the window triggers no DOM restore but is kept", () => {
    const m = mount(env, body);
    m.view.setRange(rng(500, 0, 510, 3));
    env.flush();
    const n = m.calls.length;
    scrollTo(env, m, 0);
    expect(m.calls.length).toBe(n);
    expect(m.view.selection).toEqual(rng(500, 0, 510, 3));
  });

  test("full re-renders re-apply the same DOM positions and leave the model unchanged", () => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 2, 2, 5));
    env.flush();
    const before = m.calls.length;
    m.view.schedule(); // a full re-render of a stale window
    env.flush();
    expect(m.calls.length).toBeGreaterThan(before);
    const last = m.calls[m.calls.length - 1]!;
    expect([rowOf(last.a), last.ao, rowOf(last.f), last.fo]).toEqual([0, 2, 2, 3]);
    expect(m.view.selection).toEqual(rng(0, 2, 2, 5));
  });

  test("a find change re-applies the selection and keeps the model", () => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 1, 2, 4));
    env.flush();
    const before = m.calls.length;
    m.view.findInput.value = "ijk";
    m.view.findInput.dispatchEvent(new FakeEvent("input"));
    env.flush();
    expect(m.calls.length).toBeGreaterThan(before);
    expect(m.view.selection).toEqual(rng(0, 1, 2, 4));
  });

  test("the restore's own selectionchange echo does not shrink the full range", () => {
    const m = mount(env, body);
    m.view.setRange(rng(10, 2, 300, 4));
    scrollTo(env, m, 4800); // start is clamped to the first rendered row
    fireSelectionChange(env); // the browser echoes the clamped selection back
    expect(m.view.selection).toEqual(rng(10, 2, 300, 4));
    scrollTo(env, m, 0);
    fireSelectionChange(env);
    expect(m.view.selection).toEqual(rng(10, 2, 300, 4));
  });

  test("a user DOM selection inside the rows becomes the model range, bottom-to-top included", () => {
    const m = mount(env, small);
    const tx = (n: number) => m.row(n).querySelector("tx")!;
    // anchor on row 2 at col 6 (offset 1 in the plain tail text node), focus on row 0 at col 1
    m.sel.set(tx(2).childNodes[2]!, 1, tx(0).childNodes[0]!, 1);
    fireSelectionChange(env);
    expect(m.view.selection).toEqual(rng(0, 1, 2, 6));
    expect(m.view.selectedText()).toBe("bcdefgh\nijklmnop\nqrstuv");
  });

  test("a selection whose endpoints sit on the lines container (rows replaced) keeps the range", () => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 0, 2, 3));
    const lc = m.chrome.querySelector("code-lines")!;
    m.sel.set(lc, 0, lc, 0);
    fireSelectionChange(env);
    expect(m.view.selection).toEqual(rng(0, 0, 2, 3));
  });
});

describe("stale ranges are dropped (AC-5)", () => {
  const ranged = () => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 0, 2, 3));
    return m;
  };

  test("a non-collapsed selection outside the whole view drops the range and copy is not intercepted", () => {
    const m = ranged();
    const o = outside();
    m.sel.set(o, 0, o, 1);
    fireSelectionChange(env);
    expect(m.view.selection).toBeNull();
    const { e, set } = copyEvent();
    m.scroller.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(set).toEqual([]);
  });

  test("endpoints in the find bar or scroller (inside the element, outside the rows) keep the range", () => {
    const m = ranged();
    m.sel.set(m.chrome.querySelector("find-input")!, 0, m.chrome.querySelector("code-scroller")!, 0);
    fireSelectionChange(env);
    expect(m.view.selection).toEqual(rng(0, 0, 2, 3));
  });

  test("a collapsed click on a row (primary press inside the lines) drops the range", () => {
    const m = ranged();
    m.linesEl.dispatchEvent(new FakeEvent("mousedown", { target: m.row(1).querySelector("tx")!, button: 0 }));
    expect(m.view.selection).toBeNull();
  });

  test("a primary press outside the whole view drops the range", () => {
    const m = ranged();
    pressDoc(env, outside());
    expect(m.view.selection).toBeNull();
  });

  test("a primary press on the find bar, scroller or scrollbar keeps the range", () => {
    const m = ranged();
    pressDoc(env, m.chrome.querySelector("find-input")!);
    pressDoc(env, m.chrome.querySelector("code-scroller")!);
    expect(m.view.selection).toEqual(rng(0, 0, 2, 3));
  });

  test("a press inside the rows is left to the row handler, not the document hook", () => {
    const m = ranged();
    pressDoc(env, m.row(1).querySelector("g")!);
    expect(m.view.selection).toEqual(rng(0, 0, 2, 3));
  });
});

describe("Cmd/Ctrl+A selects the whole file (AC-6)", () => {
  for (const mod of ["metaKey", "ctrlKey"]) {
    test(`${mod}+A is prevented, selects everything and copy yields the whole file`, () => {
      const m = mount(env, "alpha\n\tbeta\ngamma");
      const e = keyA({ [mod]: true });
      m.scroller.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      expect(m.view.selection).toEqual(rng(0, 0, 2, 5));
      const c = copyEvent();
      m.scroller.dispatchEvent(c.e);
      expect(c.set).toEqual([["text/plain", "alpha\n\tbeta\ngamma"]]);
    });
  }
  test("a 1000-line file is selected whole although only a window is rendered", () => {
    const m = mount(env, body);
    m.scroller.dispatchEvent(keyA({ metaKey: true }));
    expect(m.view.selection).toEqual(rng(0, 0, 999, "line 999 text".length));
    expect(m.view.selectedText()).toBe(body);
  });
  test("plain A, Shift+Ctrl+A and Alt+Ctrl+A are left alone", () => {
    const m = mount(env, "alpha\nbeta");
    for (const init of [{}, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }]) {
      const e = keyA(init);
      m.scroller.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(m.view.selection).toBeNull();
  });
  test("Cmd+A inside the find input stays native", () => {
    const m = mount(env, "alpha\nbeta");
    const e = keyA({ metaKey: true });
    m.view.findInput.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(m.view.selection).toBeNull();
  });
  test("selectAll() API matches", () => {
    const m = mount(env, "a\nbb\nccc");
    m.view.selectAll();
    expect(m.view.selection).toEqual(rng(0, 0, 2, 3));
    expect(m.view.selectedText()).toBe("a\nbb\nccc");
  });
});

describe("right / Ctrl+click keep the selection (AC-7)", () => {
  const press = (init: Record<string, unknown>) => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 0, 2, 3));
    m.linesEl.dispatchEvent(new FakeEvent("mousedown", { target: m.row(1).querySelector("tx")!, button: 0, ...init }));
    return m;
  };
  test("secondary press inside the view keeps the range", () => {
    expect(press({ button: 2 }).view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("Ctrl+click inside the view keeps the range", () => {
    expect(press({ ctrlKey: true }).view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("primary click inside clears it", () => {
    expect(press({}).view.selection).toBeNull();
  });
  test("secondary or Ctrl press elsewhere on the page keeps the range too", () => {
    const m = mount(env, small);
    m.view.setRange(rng(0, 0, 2, 3));
    pressDoc(env, outside(), { ctrlKey: true });
    pressDoc(env, outside(), { button: 2 });
    expect(m.view.selection).toEqual(rng(0, 0, 2, 3));
  });
  test("right-click on a line still makes it the active line", () => {
    expect(press({ button: 2 }).view.activeLine).toBe(1);
  });
});
