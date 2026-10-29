import { describe, expect, test } from "bun:test";
import { pruneToRange, type PNode, type PrunedNode } from "../src/client/mdsnap.ts";

interface N extends PNode {
  tag?: string;
  children: N[];
}
const t = (text: string): N => ({ text, children: [] });
const e = (tag: string, ...children: N[]): N => ({ tag, children });
const show = (p: PrunedNode<N>): string =>
  p.src.text !== undefined ? JSON.stringify(p.text) : `${p.src.tag}[${p.children.map(show).join(",")}]`;

describe("pruneToRange (R-07)", () => {
  test("keeps selected text that follows a removed inline element", () => {
    const hello = t("Hello "), world = t(" world");
    const p = e("p", hello, e("em", t("x")), world);
    const r = pruneToRange(p, { node: world, offset: 1 }, { node: p, offset: 3 });
    expect(show(r)).toBe('p["world"]');
  });
  test("whole range keeps everything untouched", () => {
    const a = t("ab"), b = t("cd");
    const p = e("p", a, e("b", b));
    const r = pruneToRange(p, { node: a, offset: 0 }, { node: b, offset: 2 });
    expect(show(r)).toBe('p["ab",b["cd"]]');
  });
  test("trims both boundary text nodes in the same node", () => {
    const a = t("abcdef");
    const p = e("p", a);
    expect(show(pruneToRange(p, { node: a, offset: 2 }, { node: a, offset: 4 }))).toBe('p["cd"]');
  });
  test("trims start and end across siblings and drops outside elements", () => {
    const a = t("one "), c = t(" three");
    const b = e("b", t("two"));
    const before = e("i", t("zzz"));
    const root = e("div", before, e("p", a, b, c), e("p", t("after")));
    const r = pruneToRange(root, { node: a, offset: 1 }, { node: c, offset: 3 });
    expect(show(r)).toBe('div[p["ne ",b["two"]," th"]]');
  });
  test("element-container boundaries select whole children", () => {
    const x = t("x"), y = t("y"), z = t("z");
    const p = e("p", x, e("em", y), z);
    expect(show(pruneToRange(p, { node: p, offset: 1 }, { node: p, offset: 2 }))).toBe('p[em["y"]]');
  });
  test("keeps selected leaf elements such as img and drops those outside", () => {
    const img1 = e("img"), img2 = e("img"), img3 = e("img");
    const a = t("a"), b = t("b");
    const p = e("p", img1, a, img2, b, img3);
    const r = pruneToRange(p, { node: p, offset: 1 }, { node: p, offset: 4 });
    expect(show(r)).toBe('p["a",img[],"b"]');
  });
  test("nested elements: text after a removed deep element survives", () => {
    const tail = t("tail");
    const li = e("li", t("gone"), e("span", e("b", t("deep"))), tail);
    const ul = e("ul", li);
    expect(show(pruneToRange(ul, { node: tail, offset: 0 }, { node: tail, offset: 4 }))).toBe('ul[li["tail"]]');
  });
  test("root is kept even when nothing is selected; empty text slices are dropped", () => {
    const a = t("abc");
    const p = e("p", a);
    expect(show(pruneToRange(p, { node: a, offset: 3 }, { node: a, offset: 3 }))).toBe("p[]");
  });
  test("pruned nodes reference their source nodes", () => {
    const a = t("abc");
    const p = e("p", a);
    const r = pruneToRange(p, { node: a, offset: 0 }, { node: a, offset: 3 });
    expect(r.src).toBe(p);
    expect(r.children[0]!.src).toBe(a);
  });
});
