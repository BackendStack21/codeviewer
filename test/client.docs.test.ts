import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function section(file: string, heading: RegExp): string {
  const t = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const m = heading.exec(t);
  if (!m) throw new Error(`${file}: heading not found`);
  const rest = t.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

const docs: [string, RegExp][] = [
  ["README.md", /^## Copy as Image$/m],
  ["DESIGN.md", /^## 15\. Copy as Image$/m],
];

describe("AC-13 Copy as Image docs", () => {
  for (const [file, heading] of docs) {
    describe(file, () => {
      const s = () => section(file, heading);
      test("describes clipboard-only, never a download", () => {
        const t = s().toLowerCase();
        expect(t).toContain("clipboard");
        expect(t).not.toContain("download");
        expect(t).not.toContain("plain text is copied");
        expect(t).not.toContain("copied text instead");
      });
      test("describes the snippet frame", () => {
        const t = s().toLowerCase();
        for (const w of ["backdrop", "window dots", "file name", "shadow", "2x"]) expect(t).toContain(w);
      });
      test("covers Markdown, the macOS native snapshot and line numbers", () => {
        const t = s().toLowerCase();
        expect(t).toContain("markdown");
        expect(t).toContain("macos");
        expect(t).toContain("line numbers");
        expect(t).toContain("never");
      });
    });
  }
});
