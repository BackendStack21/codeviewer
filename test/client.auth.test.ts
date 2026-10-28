import { afterAll, describe, expect, test } from "bun:test";
import { installDom, uninstallDom } from "./helpers/fakedom.ts";

afterAll(() => uninstallDom());

describe("auth token", () => {
  test("takes the token from the fragment, stores it, cleans the URL and wraps fetch", async () => {
    const dom = installDom({ hash: "#t=abc-123_X" });
    const seen: { input: unknown; init?: RequestInit }[] = [];
    dom.window.fetch = async (input: unknown, init?: RequestInit) => {
      seen.push({ input, init });
      return new Response("ok");
    };
    const a = await import("../src/client/auth.ts?frag");
    expect(a.token).toBe("abc-123_X");
    expect(dom.sessionStorage.getItem("cv:token")).toBe("abc-123_X");
    expect(dom.history.calls).toEqual([[null, "", "/"]]);

    const f = dom.window.fetch as typeof fetch;
    await f("/api/info", { headers: { "x-other": "1" }, method: "POST" });
    await f("https://elsewhere.test/x");
    await f("relative/no-slash");
    const h0 = new Headers(seen[0]!.init!.headers);
    expect(h0.get("x-cv-token")).toBe("abc-123_X");
    expect(h0.get("x-other")).toBe("1");
    expect(seen[0]!.init!.method).toBe("POST");
    expect(seen[1]!.init).toEqual({});
    expect(seen[2]!.init).toEqual({});
    expect(typeof (f as unknown as { preconnect: unknown }).preconnect).toBe("function");

    // ws url carries the token as a query parameter and switches scheme
    expect(a.wsUrl("/ws/term?id=1")).toBe("ws://127.0.0.1:4000/ws/term?id=1&t=abc-123_X");
  });

  test("falls back to sessionStorage when the fragment has no token", async () => {
    const dom = installDom({ hash: "#other=1" });
    dom.sessionStorage.setItem("cv:token", "saved");
    const orig = (dom.window.fetch = async () => new Response(""));
    const a = await import("../src/client/auth.ts?stored");
    expect(a.token).toBe("saved");
    expect(dom.history.calls).toEqual([]);
    expect(dom.window.fetch).not.toBe(orig);
  });

  test("no token anywhere: fetch left alone, wsUrl sends empty t, https gives wss", async () => {
    const dom = installDom({ hash: "", protocol: "https:", href: "https://host.test/app" });
    const orig = (dom.window.fetch = async () => new Response(""));
    const a = await import("../src/client/auth.ts?none");
    expect(a.token).toBeNull();
    expect(dom.window.fetch).toBe(orig);
    expect(a.wsUrl("/events")).toBe("wss://host.test/events?t=");
  });

  test("storage failures are tolerated", async () => {
    const dom = installDom({ hash: "#t=zzz" });
    dom.sessionStorage.throws = true;
    dom.window.fetch = async () => new Response("");
    const a = await import("../src/client/auth.ts?throws");
    expect(a.token).toBe("zzz");

    const dom2 = installDom({ hash: "" });
    dom2.sessionStorage.throws = true;
    dom2.window.fetch = async () => new Response("");
    const b = await import("../src/client/auth.ts?throws2");
    expect(b.token).toBeNull();
  });
});
