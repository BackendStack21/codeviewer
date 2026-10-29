import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../${p}`, import.meta.url)).text();

describe("SL06 docs", () => {
  test("README has a Markdown section with the toggle, caps and image policy", async () => {
    const t = await read("README.md");
    expect(t).toMatch(/^#{2,3} .*Markdown/m);
    const section = t.slice(t.search(/^#{2,3} .*Markdown/m));
    expect(section).toContain("Toggle Markdown Preview");
    expect(section).toMatch(/1 ?MiB/);
    expect(section).toMatch(/Render anyway/);
    expect(section).toMatch(/100 images/);
    expect(section).toMatch(/remote images/i);
    expect(section).toMatch(/raw HTML/i);
  });

  test("SECURITY.md documents the Markdown trust model", async () => {
    const t = await read("SECURITY.md");
    expect(t).toMatch(/Markdown/);
    expect(t).toMatch(/untrusted/i);
    expect(t).toMatch(/innerHTML/);
    expect(t).toMatch(/remote images/i);
    expect(t).toMatch(/blob/i);
  });
});

describe("SL06 wiring pins (editor.ts and app.ts cannot be loaded under the fake DOM)", () => {
  test("the editor applies the size gate and passes the link fragment through", async () => {
    const t = await read("src/client/editor.ts");
    expect(t).toContain("decidePreview(");
    expect(t).toContain("tooLargeNote(");
    expect(t).toContain("scrollToFragment(");
    expect(t).toMatch(/onOpenLink\s*:\s*\(path: string, hash/);
  });

  test("the app registers the Toggle Markdown Preview command", async () => {
    const t = await read("src/client/app.ts");
    expect(t).toContain("markdownToggleCommand(");
  });
});
