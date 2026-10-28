import { describe, expect, test } from "bun:test";
import { chevron, fileColor, fileIcon, folderIcon, icons } from "../src/client/icons.ts";

describe("icons", () => {
  test("fileColor: by extension, case-insensitive", () => {
    expect(fileColor("a.ts")).toBe("#4b8fe0");
    expect(fileColor("A.TS")).toBe("#4b8fe0");
    expect(fileColor("x.tar.gz")).toBe("#a8a5a0");
  });
  test("fileColor: named files beat extensions", () => {
    expect(fileColor("package.json")).toBe("#7cc36a");
    expect(fileColor("Dockerfile")).toBe("#4f9fe0");
    expect(fileColor("sub.json")).toBe("#d9a54a");
  });
  test("fileColor: unknown extension / no extension fall back to the CSS var", () => {
    expect(fileColor("a.unknownext")).toBe("var(--icon-file)");
    expect(fileColor("noext")).toBe("var(--icon-file)");
  });
  test("fileIcon embeds the tint", () => {
    const s = fileIcon("main.rs");
    expect(s).toContain('class="ico"');
    expect(s).toContain('stroke="#de7a4f"');
    expect(s).toContain('fill="#de7a4f"');
  });
  test("folderIcon open vs closed differ and use the folder var", () => {
    const o = folderIcon(true);
    const c = folderIcon(false);
    expect(o).not.toBe(c);
    expect(o).toContain("var(--icon-folder)");
    expect(c).toContain("var(--icon-folder)");
    expect(o.match(/<path/g)!.length).toBe(2);
    expect(c.match(/<path/g)!.length).toBe(1);
  });
  test("static icons are svg strings", () => {
    expect(chevron).toContain('class="chev"');
    for (const [k, v] of Object.entries(icons)) {
      expect(v.startsWith("<svg"), k).toBe(true);
      expect(v.endsWith("</svg>"), k).toBe(true);
    }
    expect(icons.logo).toContain("linearGradient");
  });
});
