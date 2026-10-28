import { afterEach, describe, expect, test } from "bun:test";
import { mockFetch } from "./helpers/fakedom.ts";
import { api } from "../src/client/api.ts";

let restore = () => {};
afterEach(() => restore());
const use = (h: Parameters<typeof mockFetch>[0]) => {
  const m = mockFetch(h);
  restore = m.restore;
  return m.calls;
};

describe("api", () => {
  test("info / list / gitStatus hit the right URLs (path is encoded)", async () => {
    const calls = use((url) => Response.json(url.startsWith("/api/list") ? [{ name: "a b", type: "file" }] : { ok: 1 }));
    expect(await api.info()).toEqual({ ok: 1 } as never);
    expect(await api.list("src/a b&c/")).toEqual([{ name: "a b", type: "file" }]);
    await api.gitStatus();
    expect(calls.map((c) => c.url)).toEqual(["/api/info", "/api/list?path=src%2Fa%20b%26c%2F", "/api/git/status"]);
  });

  test("errors use the JSON error body, else the status text", async () => {
    use(() => Response.json({ error: "nope" }, { status: 403 }));
    await expect(api.info()).rejects.toThrow("nope");
    restore();
    use(() => new Response("not json", { status: 500, statusText: "Boom" }));
    await expect(api.list("x")).rejects.toThrow("Boom");
  });

  test("index splits lines; empty body means no files", async () => {
    use(() => new Response("a.ts\nb/c.ts"));
    expect(await api.index()).toEqual(["a.ts", "b/c.ts"]);
    restore();
    use(() => new Response(""));
    expect(await api.index()).toEqual([]);
  });

  test("file parses x-cv-* headers and defaults", async () => {
    const calls = use(() => new Response("hello", { headers: { "x-cv-kind": "image", "x-cv-size": "42", "x-cv-mtime": "1700", "x-cv-truncated": "1", "x-cv-encoding": "UTF-16LE" } }));
    expect(await api.file("a/b.ts", true)).toEqual({ kind: "image", size: 42, mtime: 1700, truncated: true, encoding: "UTF-16LE", text: "hello" });
    expect(calls[0]!.url).toBe("/api/file?path=a%2Fb.ts&text=1");
    restore();
    const c2 = use(() => new Response("x"));
    const f = await api.file("p");
    expect(c2[0]!.url).toBe("/api/file?path=p");
    expect(f).toMatchObject({ kind: "text", truncated: false, encoding: "UTF-8", text: "x" });
    expect(f.size).toBe(0);
  });

  test("stat returns the type or null", async () => {
    use(() => Response.json({ type: "dir" }));
    expect(await api.stat("d")).toBe("dir");
    restore();
    use(() => new Response("", { status: 404 }));
    expect(await api.stat("d")).toBeNull();
  });

  test("gitBase / gitBlame return null on failure", async () => {
    const calls = use((url) => (url.includes("base") ? new Response("HEAD text") : Response.json({ hash: "abc" })));
    expect(await api.gitBase("f")).toBe("HEAD text");
    expect(await api.gitBlame("f", 7)).toEqual({ hash: "abc" } as never);
    expect(calls.map((c) => c.url)).toEqual(["/api/git/base?path=f", "/api/git/blame?path=f&line=7"]);
    restore();
    use(() => new Response("", { status: 404 }));
    expect(await api.gitBase("f")).toBeNull();
    expect(await api.gitBlame("f", 1)).toBeNull();
  });

  test("update / install / relaunch", async () => {
    const calls = use(() => Response.json({ current: "1.0.0" }));
    await api.update();
    await api.update(true);
    await api.updateInstall();
    await api.updateRelaunch();
    expect(calls.map((c) => c.url)).toEqual(["/api/update", "/api/update?check=1", "/api/update/install", "/api/update/relaunch"]);
    expect(calls[2]!.init).toMatchObject({ method: "POST", body: "{}" });
    expect(calls[3]!.init?.method).toBe("POST");
    restore();
    use(() => Response.json({ error: "locked" }, { status: 409 }));
    await expect(api.updateInstall()).rejects.toThrow("locked");
  });

  test("external posts the url as JSON", async () => {
    const calls = use(() => new Response("{}"));
    await api.external("https://example.com/x");
    expect(calls[0]!.url).toBe("/api/external");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ url: "https://example.com/x" });
  });

  test("rawBlobUrl and head", async () => {
    const calls = use(() => new Response(new Uint8Array([1, 2, 3])));
    const url = await api.rawBlobUrl("img.png");
    expect(url.startsWith("blob:")).toBe(true);
    URL.revokeObjectURL(url);
    expect([...(await api.head("img.png", 3))]).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.url)).toEqual(["/api/raw?path=img.png", "/api/raw?path=img.png&limit=3"]);
  });
});
