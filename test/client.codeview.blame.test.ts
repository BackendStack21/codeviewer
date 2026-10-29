import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FakeEvent, uninstallDom } from "./helpers/fakedom.ts";
import { fireSelectionChange, loadCodeView, mount, type Env, type Mounted, type N } from "./helpers/selfake.ts";

let env: Env;
beforeAll(async () => {
  env = await loadCodeView();
});
afterAll(() => uninstallDom());

const body = Array.from({ length: 300 }, (_, i) => `line ${i} text`).join("\n");
const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
const editorSrc = readFileSync(new URL("../src/client/editor.ts", import.meta.url), "utf8");

const blameOf = (r: N) => r.querySelector("blame");
const shown = (m: Mounted) => m.rows().filter((r) => blameOf(r)).length;
const tx = (m: Mounted, n: number) => m.row(n).querySelector("tx")!;
const press = (m: Mounted, n: number, init: Record<string, unknown> = {}) =>
  m.linesEl.dispatchEvent(new FakeEvent("mousedown", { target: m.row(n).childNodes[0], button: 0, ...init }));
const release = () => {
  env.dom.document.dispatchEvent(new FakeEvent("mouseup", { button: 0 }));
  env.dom.window.dispatchEvent(new FakeEvent("mouseup", { button: 0 }));
};
/** DOM Node.contains is inclusive: contains(self) is true. */
function inclusive(m: Mounted) {
  const inner = m.linesEl.contains;
  m.linesEl.contains = (n: unknown) => n === m.linesEl || inner(n);
}

describe("AC-8 active line and blame are patched in place", () => {
  test("setActiveLine keeps every row object and moves the active class", () => {
    const m = mount(env, body);
    const before = m.rows().slice();
    m.view.setActiveLine(3);
    env.flush();
    expect(m.rows().length).toBe(before.length);
    expect(m.rows().every((r, i) => r === before[i])).toBe(true);
    m.view.setActiveLine(5);
    env.flush();
    expect(m.rows().every((r, i) => r === before[i])).toBe(true);
    expect(m.row(3).classList.contains("active")).toBe(false);
    expect(m.row(5).classList.contains("active")).toBe(true);
  });

  test("setBlame keeps every row object and patches one blame span", () => {
    const m = mount(env, body);
    const before = m.rows().slice();
    m.view.setActiveLine(2);
    m.view.setBlame(2, "Ann, today");
    env.flush();
    expect(m.rows().every((r, i) => r === before[i])).toBe(true);
    expect(shown(m)).toBe(1);
    expect(blameOf(m.row(2))!.textContent).toBe("Ann, today");
    m.view.setBlame(4, "Bob");
    env.flush();
    expect(m.rows().every((r, i) => r === before[i])).toBe(true);
    expect(blameOf(m.row(2))).toBeNull();
    expect(blameOf(m.row(4))!.textContent).toBe("Bob");
    m.view.setBlame(4, null);
    env.flush();
    expect(m.rows().every((r, i) => r === before[i])).toBe(true);
    expect(shown(m)).toBe(0);
  });

  test("a later render still draws the label on its line", () => {
    const m = mount(env, body);
    m.view.setBlame(2, "Ann");
    env.flush();
    m.view.setText(body.replace("line 9 ", "line 9x "));
    env.flush();
    expect(blameOf(m.row(2))).toBeNull(); // setText resets blame
    m.view.setBlame(2, "Ann");
    m.view.schedule();
    env.flush();
    expect(blameOf(m.row(2))!.textContent).toBe("Ann");
  });
});

describe("AC-9 the label waits for the button and the selection", () => {
  test("no label while the primary button is held; it appears after mouseup", () => {
    const m = mount(env, body);
    press(m, 1);
    m.view.setBlame(1, "Ann");
    env.flush();
    expect(shown(m)).toBe(0);
    release();
    env.flush();
    expect(blameOf(m.row(1))!.textContent).toBe("Ann");
  });

  test("a non-collapsed live selection hides the label while it exists", () => {
    const m = mount(env, body);
    m.view.setActiveLine(1);
    m.view.setBlame(1, "Ann");
    env.flush();
    expect(shown(m)).toBe(1);
    m.sel.set(tx(m, 1).childNodes[0]!, 0, tx(m, 2).childNodes[0]!, 1);
    fireSelectionChange(env);
    env.flush();
    expect(shown(m)).toBe(0);
    m.view.setBlame(1, "Kay");
    env.flush();
    expect(shown(m)).toBe(0);
    press(m, 1); // a plain click clears the range
    m.sel.set(tx(m, 1).childNodes[0]!, 0, tx(m, 1).childNodes[0]!, 0, true);
    release();
    fireSelectionChange(env);
    env.flush();
    expect(blameOf(m.row(1))!.textContent).toBe("Kay");
  });

  test("a keyboard active-line change after the selection collapsed shows its blame", () => {
    const m = mount(env, body);
    press(m, 1);
    m.sel.set(tx(m, 1).childNodes[0]!, 0, tx(m, 2).childNodes[0]!, 1);
    release();
    m.sel.isCollapsed = true;
    fireSelectionChange(env);
    m.view.setActiveLine(3);
    m.view.setBlame(3, "Bob");
    env.flush();
    expect(blameOf(m.row(3))!.textContent).toBe("Bob");
  });

  test("select-all (model range) hides the label", () => {
    const m = mount(env, body);
    m.view.setBlame(1, "Ann");
    env.flush();
    m.view.selectAll();
    env.flush();
    m.view.setBlame(1, "Ann");
    env.flush();
    expect(shown(m)).toBe(0);
  });

  test("the held state never sticks: blur, buttonless mousemove, next mousedown", () => {
    for (const clear of [
      () => env.dom.window.dispatchEvent(new FakeEvent("blur")),
      () => env.dom.document.dispatchEvent(new FakeEvent("mousemove", { buttons: 0 })),
      (m: Mounted) => press(m, 2, { button: 2 }),
    ]) {
      const m = mount(env, body);
      press(m, 1);
      clear(m);
      m.view.setBlame(1, "Ann");
      env.flush();
      expect(shown(m)).toBe(1);
    }
  });

  test("a mousemove with the primary button down keeps the hold", () => {
    const m = mount(env, body);
    press(m, 1);
    env.dom.document.dispatchEvent(new FakeEvent("mousemove", { buttons: 1 }));
    m.view.setBlame(1, "Ann");
    env.flush();
    expect(shown(m)).toBe(0);
  });
});

describe("AC-10 editor wiring", () => {
  test("changing the active line clears the blame through setBlame and reloads it after a debounce", () => {
    const i = editorSrc.indexOf("code.onActiveLine");
    expect(i).toBeGreaterThan(0);
    const wiring = editorSrc.slice(i, i + 200);
    expect(wiring).toContain("code.setBlame(line, null)");
    expect(wiring).toContain("blame(line)");
    expect(editorSrc).toContain("debounce((line: number) => void this.loadBlame(");
  });

  test("setBlame(line, null) removes the label without rebuilding rows", () => {
    const m = mount(env, body);
    m.view.setBlame(1, "Ann");
    env.flush();
    const r = m.row(1);
    m.view.setBlame(1, null);
    env.flush();
    expect(m.row(1)).toBe(r);
    expect(blameOf(r)).toBeNull();
  });
});

describe("AC-13 a bottom-to-top drag keeps its anchor", () => {
  test("active line and blame arrive mid-drag; anchor nodes and selection survive; range normalises", () => {
    const m = mount(env, body);
    inclusive(m);
    press(m, 5);
    const anchorRow = m.row(5);
    const anchorText = tx(m, 5).childNodes[0]!;
    m.sel.set(anchorText, 2, tx(m, 2).childNodes[0]!, 1);
    fireSelectionChange(env);
    m.view.setActiveLine(2);
    m.view.setBlame(2, "Ann");
    env.flush();
    expect(m.row(5)).toBe(anchorRow);
    expect(tx(m, 5).childNodes[0]).toBe(anchorText);
    expect(m.linesEl.contains(anchorText)).toBe(true);
    expect(m.sel.anchorNode).toBe(anchorText);
    expect(m.sel.anchorOffset).toBe(2);
    expect(shown(m)).toBe(0);
    release();
    fireSelectionChange(env);
    env.flush();
    const r = m.view.selection!;
    expect(r.start.line).toBe(2);
    expect(r.start.col).toBe(1);
    expect(r.end.line).toBe(5);
    expect(r.end.col).toBe(2);
    expect(m.sel.anchorNode).toBe(anchorText);
  });
});

describe("AC-14 the label never shifts the text", () => {
  test("setBlame while held inserts nothing and leaves every .tx text node untouched", () => {
    const m = mount(env, body);
    press(m, 3);
    const nodes = m.rows().map((r) => r.querySelector("tx")!.childNodes[0]!);
    const data = nodes.map((n) => n.data);
    m.view.setBlame(3, "Ann");
    m.view.setBlame(4, "Bob");
    env.flush();
    expect(shown(m)).toBe(0);
    m.rows().forEach((r, i) => {
      expect(r.querySelector("tx")!.childNodes[0]).toBe(nodes[i]!);
      expect(nodes[i]!.data).toBe(data[i]!);
    });
  });

  test("after release the label is added without touching the text node", () => {
    const m = mount(env, body);
    const t = tx(m, 3).childNodes[0]!;
    const d = t.data;
    m.view.setBlame(3, "Ann");
    env.flush();
    expect(tx(m, 3).childNodes[0]).toBe(t);
    expect(t.data).toBe(d);
    expect(blameOf(m.row(3))!.parent).toBe(m.row(3));
  });

  test("styles.css: .blame is out of the text flow (absolute or sticky)", () => {
    const m = /(^|\n)\.blame\s*\{([^}]*)\}/.exec(css);
    expect(m).not.toBeNull();
    expect(m![2]).toMatch(/position:\s*(absolute|sticky)/);
  });
});

describe("SL02 minor: no duplicate declaration in the macOS titlebar rule", () => {
  test("-webkit-user-select appears once", () => {
    const head = css.indexOf(':root[data-native="macos"] .titlebar {');
    expect(head).toBeGreaterThan(0);
    const block = css.slice(head, css.indexOf("}", head));
    expect(block.split("-webkit-user-select: none").length - 1).toBe(1);
    expect(block).toContain("user-select: none");
  });
});
