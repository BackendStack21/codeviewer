import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";

let I: typeof import("../src/client/mdimage.ts");
let M: typeof import("../src/client/markdown.ts");
let R: typeof import("../src/client/mdrender.ts");
let V: typeof import("../src/client/mdview.ts");
beforeAll(async () => {
  installDom();
  try {
    I = await import("../src/client/mdimage.ts");
    M = await import("../src/client/markdown.ts");
    R = await import("../src/client/mdrender.ts");
    V = await import("../src/client/mdview.ts");
  } catch {}
});
afterAll(() => uninstallDom());

const q = (el: unknown, sel: string) => (el as FakeElement).querySelectorAll<FakeElement>(sel);
const flush = () => new Promise((r) => setTimeout(r, 15));

let created: string[] = [];
let revoked: string[] = [];
let calls: { url: string }[] = [];
let restoreFetch = () => {};
let origCreate: typeof URL.createObjectURL;
let origRevoke: typeof URL.revokeObjectURL;
let counter = 0;
let respond: (url: string) => Response = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });

beforeEach(() => {
  created = [];
  revoked = [];
  counter = 0;
  respond = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  origCreate = URL.createObjectURL;
  origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (() => {
    const u = `blob:test/${++counter}`;
    created.push(u);
    return u;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((u: string) => void revoked.push(u)) as typeof URL.revokeObjectURL;
  const m = mockFetch((url) => respond(url));
  calls = m.calls;
  restoreFetch = m.restore;
});
afterEach(() => {
  restoreFetch();
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
});

const view = (src: string, path = "docs/a.md") => new V.MarkdownView(src, 13, { path });

describe("AC-20 classifyImage (pure)", () => {
  test("raster and SVG extensions resolve to a repo path, case-insensitively", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "PNG", "Svg"]) {
      expect(I.classifyImage(`img/x.${ext}`, "docs")).toEqual({ kind: "repo", path: `docs/img/x.${ext}` });
    }
  });

  test("the path is resolved against the document folder; query and fragment are dropped; percent-decoded once", () => {
    expect(I.classifyImage("../x.png", "docs/sub")).toEqual({ kind: "repo", path: "docs/x.png" });
    expect(I.classifyImage("x.png?v=1#h", "")).toEqual({ kind: "repo", path: "x.png" });
    expect(I.classifyImage("my%20pic.png", "d")).toEqual({ kind: "repo", path: "d/my pic.png" });
    expect(I.classifyImage("/abs.png", "docs")).toEqual({ kind: "repo", path: "abs.png" });
  });

  test("non-image extensions and dotfiles are never fetched", () => {
    for (const src of [".env", "a.txt", "a.md", "noext", "x.png.txt", "a.ts", ".png", "dir/", "a.png.", "secret.json", "id_rsa"]) {
      expect(I.classifyImage(src, "docs")).toEqual({ kind: "none" });
    }
  });

  test("escaping the root, API paths and odd inputs are none", () => {
    for (const src of ["../../x.png", "../../../etc/passwd.png", "a\\b.png", "x\u0000.png", "", "javascript:x.png", "file:///a.png", "blob:http://x/y.png"]) {
      expect(I.classifyImage(src, "docs")).toEqual({ kind: "none" });
    }
  });

  test("http(s) is a remote placeholder with a link; // and data: are placeholders without one", () => {
    expect(I.classifyImage("https://a.example/b.png", "")).toEqual({ kind: "remote", href: "https://a.example/b.png", host: "a.example" });
    expect(I.classifyImage("http://img.test/x/y.gif", "")).toEqual({ kind: "remote", href: "http://img.test/x/y.gif", host: "img.test" });
    expect(I.classifyImage("//cdn.test/b.png", "")).toEqual({ kind: "remote", href: "", host: "cdn.test" });
    expect(I.classifyImage("data:image/png;base64,AAAA", "")).toEqual({ kind: "remote", href: "", host: "" });
  });

  test("the image cap is 100", () => {
    expect(I.MAX_IMAGES).toBe(100);
  });
});

describe("AC-20 relative images load through api.rawBlobUrl", () => {
  test("the img src is the blob URL, never the source text, and alt is kept", async () => {
    const v = view("![the alt](img/x.png)");
    await flush();
    expect(calls.map((c) => c.url)).toEqual([`/api/raw?path=docs%2Fimg%2Fx.png&max=${I.MAX_IMAGE_BYTES}`]);
    const imgs = q(v.el, "img");
    expect(imgs.length).toBe(1);
    expect(imgs[0]!.getAttribute("src")).toBe(created[0]!);
    expect(imgs[0]!.getAttribute("src")).not.toContain("x.png");
    expect(imgs[0]!.getAttribute("alt")).toBe("the alt");
  });

  test("an SVG loads as an img blob, never inlined", async () => {
    const v = view("![](logo.svg)");
    await flush();
    expect(q(v.el, "img").length).toBe(1);
    expect(q(v.el, "svg").length).toBe(0);
  });

  test("images inside links and lists load too", async () => {
    const v = view("- [![a](a.png)](b.md)\n- ![b](b.png)");
    await flush();
    expect(q(v.el, "img").length).toBe(2);
    expect(calls.length).toBe(2);
  });

  test("![](.env) and other non-image files are never fetched and show the alt text", async () => {
    const v = view("![env](.env) ![txt](a.txt) ![md](a.md)");
    await flush();
    expect(calls.length).toBe(0);
    expect(q(v.el, "img").length).toBe(0);
    const t = (v.el as FakeElement).textContent;
    expect(t).toContain("env");
    expect(t).toContain("txt");
  });

  test("a path that escapes the root is never fetched", async () => {
    const v = view("![x](../../x.png)");
    await flush();
    expect(calls.length).toBe(0);
    expect(q(v.el, "img").length).toBe(0);
  });

  test("a failed fetch leaves the alt text and no src, and does not throw", async () => {
    respond = () => new Response(JSON.stringify({ error: "nope" }), { status: 404 });
    const v = view("![gone](missing.png)");
    await flush();
    expect(q(v.el, "img").filter((i) => i.getAttribute("src") !== null).length).toBe(0);
    expect((v.el as FakeElement).textContent).toContain("gone");
    expect(created.length).toBe(0);
  });

  test("renderMarkdown alone (no loader) makes no request and sets no src", async () => {
    const el = R.renderMarkdown(M.parseMarkdown("![a](x.png)"), { base: "" });
    await flush();
    expect(calls.length).toBe(0);
    expect(q(el, "img").filter((i) => i.getAttribute("src") !== null).length).toBe(0);
  });

  test("at most 100 images are loaded per render", async () => {
    const src = Array.from({ length: 150 }, (_, i) => `![alt${i}](i${i}.png)`).join("\n\n");
    const v = view(src);
    await flush();
    expect(calls.length).toBe(100);
    expect(q(v.el, "img").length).toBe(100);
    expect(created.length).toBe(100);
    expect((v.el as FakeElement).textContent).toContain("alt120");
  });
});

describe("AC-20 blob URLs are revoked", () => {
  test("re-render revokes the previous blob URLs", async () => {
    const v = view("![a](a.png)");
    await flush();
    expect(created.length).toBe(1);
    expect(revoked).toEqual([]);
    expect(v.setText("![b](b.png)")).toBe(true);
    await flush();
    expect(revoked).toEqual([created[0]!]);
    expect(created.length).toBe(2);
    expect(q(v.el, "img")[0]!.getAttribute("src")).toBe(created[1]!);
  });

  test("identical text neither reloads nor revokes", async () => {
    const v = view("![a](a.png)");
    await flush();
    expect(v.setText("![a](a.png)")).toBe(false);
    await flush();
    expect(revoked).toEqual([]);
    expect(calls.length).toBe(1);
  });

  test("dispose revokes everything created", async () => {
    const v = view("![a](a.png) ![b](b.png)");
    await flush();
    expect(created.length).toBe(2);
    v.dispose();
    expect([...revoked].sort()).toEqual([...created].sort());
  });

  test("a blob that resolves after the render was replaced is revoked, not shown", async () => {
    const v = view("![a](a.png)");
    v.setText("plain text");
    await flush();
    expect(created.length).toBe(revoked.length);
    expect([...revoked].sort()).toEqual([...created].sort());
    expect(q(v.el, "img").length).toBe(0);
  });

  test("a blob that resolves after dispose is revoked", async () => {
    const v = view("![a](a.png)");
    v.dispose();
    await flush();
    expect(created.length).toBe(1);
    expect([...revoked].sort()).toEqual([...created].sort());
  });

  test("created equals revoked after a full lifecycle", async () => {
    const v = view("![a](a.png) ![b](b.png)");
    await flush();
    v.setText("![c](c.png)");
    await flush();
    v.setText("![d](d.png) ![e](e.png) ![f](f.png)");
    await flush();
    v.dispose();
    await flush();
    expect(created.length).toBe(6);
    expect([...revoked].sort()).toEqual([...created].sort());
  });
});

describe("AC-21 remote images never load", () => {
  test("https image: placeholder with alt and host, a safe open link, no img and no src anywhere", async () => {
    const v = view("![logo](https://a.example/b.png)");
    await flush();
    expect(calls.length).toBe(0);
    expect(q(v.el, "img").length).toBe(0);
    const ph = q(v.el, ".md-img-remote");
    expect(ph.length).toBe(1);
    expect(ph[0]!.textContent).toContain("logo");
    expect(ph[0]!.textContent).toContain("a.example");
    const a = q(ph[0]!, "a");
    expect(a.length).toBe(1);
    expect(a[0]!.getAttribute("href")).toBe("https://a.example/b.png");
    expect(a[0]!.getAttribute("target")).toBe("_blank");
    expect(a[0]!.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    const walk = (e: FakeElement) => {
      expect(e.getAttribute("src")).toBeNull();
      for (const c of e.children) if ("tag" in c) walk(c);
    };
    walk(v.el as FakeElement);
  });

  test("protocol-relative: placeholder with alt and host, no link, no img", async () => {
    const v = view("![cdn pic](//cdn.test/b.png)");
    await flush();
    expect(q(v.el, "img").length).toBe(0);
    expect(calls.length).toBe(0);
    const ph = q(v.el, ".md-img-remote");
    expect(ph.length).toBe(1);
    expect(ph[0]!.textContent).toContain("cdn pic");
    expect(ph[0]!.textContent).toContain("cdn.test");
    expect(q(ph[0]!, "a").length).toBe(0);
  });

  test("data: image: placeholder with alt, payload not echoed, no link, no img", async () => {
    const v = view("![inline](data:image/png;base64,QUFBQUFB)");
    await flush();
    expect(q(v.el, "img").length).toBe(0);
    const ph = q(v.el, ".md-img-remote");
    expect(ph.length).toBe(1);
    expect(ph[0]!.textContent).toContain("inline");
    expect((v.el as FakeElement).textContent).not.toContain("QUFBQUFB");
    expect(q(ph[0]!, "a").length).toBe(0);
  });

  test("javascript: and file: image sources render only the alt text", async () => {
    const v = view("![j](javascript:alert(1)) ![f](file:///etc/passwd)");
    await flush();
    expect(q(v.el, "img").length).toBe(0);
    expect(q(v.el, "a").length).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("the response CSP is unchanged: img-src stays 'self' data: blob:", async () => {
    const src = await Bun.file(new URL("../src/server/http.ts", import.meta.url)).text();
    expect(src).toContain(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self'; ",
    );
    expect(src).toContain("object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  });
});
