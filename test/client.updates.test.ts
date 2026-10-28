import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { FakeEvent, installDom, mockFetch, uninstallDom, type Dom, type FakeElement } from "./helpers/fakedom.ts";
import type { UpdateInfo } from "../src/client/api.ts";

let dom: Dom;
let U: typeof import("../src/client/updates.ts");
beforeAll(async () => {
  dom = installDom();
  U = await import("../src/client/updates.ts");
});
afterAll(() => uninstallDom());

const info = (o: Partial<UpdateInfo> = {}): UpdateInfo => ({ current: "1.0.0", latest: "1.1.0", available: true, kind: "macos-app", canInstall: true, checkedAt: 1, ...o });
let restore = () => {};
afterEach(() => restore());

const setup = (handler: Parameters<typeof mockFetch>[0] = () => Response.json(info())) => {
  const m = mockFetch(handler);
  restore = m.restore;
  const u = new U.Updates();
  const box = u.el.querySelector<FakeElement>(".upd")!;
  const btn = (label: string) => box.querySelectorAll<FakeElement>("button").find((b) => b.textContent === label);
  const click = (label: string) => btn(label)!.dispatchEvent(new FakeEvent("click"));
  const states = () => box.querySelectorAll<FakeElement>("li").map((l) => l.getAttribute("data-state"));
  return { u, box, btn, click, states, calls: m.calls, flush: () => new Promise((r) => setTimeout(r, 0)) };
};

describe("Updates", () => {
  test("starts hidden with dialog semantics", () => {
    const { u, box } = setup();
    expect(u.el.hidden).toBe(true);
    expect(box.getAttribute("role")).toBe("dialog");
    expect(box.getAttribute("aria-modal")).toBe("true");
  });

  test("load stores the info and notifies onInfo; failures are silent", async () => {
    const t = setup(() => Response.json(info({ latest: "2.0.0" })));
    const got: UpdateInfo[] = [];
    t.u.onInfo = (i) => got.push(i);
    await t.u.load();
    expect(got.map((i) => i.latest)).toEqual(["2.0.0"]);
    expect(t.calls[0]!.url).toBe("/api/update");
    restore();
    const t2 = setup(() => new Response("", { status: 500 }));
    await t2.u.load();
    expect(t2.u.info).toBeNull();
  });

  test("open with no info shows nothing yet; with info renders the available dialog", async () => {
    const t = setup(() => Response.json(info({ notes: "  Fixed things  " })));
    t.u.open();
    expect(t.u.el.hidden).toBe(false);
    expect(t.box.children.length).toBe(0);
    await t.u.load();
    t.u.open();
    expect(t.box.textContent).toContain("Codeviewer 1.1.0 is available");
    expect(t.box.textContent).toContain("You have 1.0.0");
    expect(t.box.querySelector(".upd-notes")!.textContent).toBe("Fixed things");
    expect(t.box.querySelectorAll("li").length).toBe(4);
    expect(t.box.querySelector("ol")!.hidden).toBe(true);
    expect(t.btn("Install and restart")).toBeTruthy();
    expect(t.btn("Later")).toBeTruthy();
  });

  test("cli kind labels the install button differently", async () => {
    const t = setup(() => Response.json(info({ kind: "cli" })));
    await t.u.load();
    t.u.open();
    expect(t.btn("Install update")).toBeTruthy();
  });

  test("not installable: shows the reason and a single OK", async () => {
    const t = setup(() => Response.json(info({ canInstall: false, reason: "Installed from source" })));
    await t.u.load();
    t.u.open();
    expect(t.box.querySelector(".upd-reason")!.textContent).toBe("Installed from source");
    expect(t.btn("Install and restart")).toBeUndefined();
    t.click("OK");
    expect(t.u.el.hidden).toBe(true);
    restore();
    const t2 = setup(() => Response.json(info({ canInstall: false })));
    await t2.u.load();
    t2.u.open();
    expect(t2.box.querySelector(".upd-reason")!.textContent).toBe("This update can't be installed automatically.");
  });

  test("Release notes opens the url externally", async () => {
    const t = setup(() => Response.json(info({ url: "https://example.com/rel" })));
    await t.u.load();
    t.u.open();
    t.click("Release notes");
    expect(t.calls.at(-1)!.url).toBe("/api/external");
    expect(JSON.parse(t.calls.at(-1)!.init!.body as string)).toEqual({ url: "https://example.com/rel" });
  });

  test("checkNow: checking state, then up-to-date message", async () => {
    const t = setup(() => Response.json(info({ available: false })));
    const p = t.u.checkNow();
    expect(t.u.el.hidden).toBe(false);
    expect(t.box.textContent).toContain("Checking for updates…");
    await p;
    expect(t.calls[0]!.url).toBe("/api/update?check=1");
    expect(t.box.textContent).toContain("You're up to date");
    expect(t.box.textContent).toContain("Codeviewer 1.0.0 is the latest version.");
    t.click("OK");
    expect(t.u.el.hidden).toBe(true);
  });

  test("checkNow failure renders an error with Try again", async () => {
    let n = 0;
    const t = setup(() => (n++ === 0 ? Response.json({ error: "rate limited" }, { status: 429 }) : Response.json(info())));
    await t.u.checkNow();
    expect(t.box.textContent).toContain("Update failed");
    expect(t.box.textContent).toContain("rate limited");
    t.click("Try again");
    await t.flush();
    await t.flush();
    expect(t.box.textContent).toContain("is available");
    expect(n).toBe(2);
  });

  test("closing: overlay mousedown and Escape close; ignored while installing", async () => {
    const t = setup();
    await t.u.load();
    t.u.open();
    t.u.el.dispatchEvent(new FakeEvent("mousedown", { target: t.box }));
    expect(t.u.el.hidden).toBe(false);
    t.u.el.dispatchEvent(new FakeEvent("mousedown", { target: t.u.el }));
    expect(t.u.el.hidden).toBe(true);
    t.u.open();
    dom.window.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    expect(t.u.el.hidden).toBe(true);

    t.u.open();
    t.click("Install and restart");
    await t.flush();
    t.u.el.dispatchEvent(new FakeEvent("mousedown", { target: t.u.el }));
    dom.window.dispatchEvent(new FakeEvent("keydown", { key: "Escape" }));
    t.box.querySelector<FakeElement>(".icon-btn")!.dispatchEvent(new FakeEvent("click"));
    expect(t.u.el.hidden).toBe(false);
  });

  test("install posts, shows the steps, disables buttons and drops the notes", async () => {
    const t = setup(() => Response.json(info({ notes: "n" })));
    await t.u.load();
    t.u.open();
    const install = t.btn("Install and restart")!;
    t.click("Install and restart");
    await t.flush();
    const post = t.calls.at(-1)!;
    expect(post.url).toBe("/api/update/install");
    expect(post.init?.method).toBe("POST");
    expect(t.box.querySelector("ol")!.hidden).toBe(false);
    expect(install.disabled).toBe(true);
    expect(install.textContent).toBe("Installing…");
    expect(t.btn("Release notes")!.disabled).toBe(true);
    expect(t.box.querySelector(".upd-notes")).toBeNull();
  });

  test("install failure goes back to an error view", async () => {
    const t = setup((url) => (url === "/api/update/install" ? Response.json({ error: "disk full" }, { status: 500 }) : Response.json(info())));
    await t.u.load();
    t.u.open();
    t.click("Install and restart");
    await t.flush();
    await t.flush();
    expect(t.box.textContent).toContain("Update failed");
    expect(t.box.textContent).toContain("disk full");
    t.click("Close");
    expect(t.u.el.hidden).toBe(true);
  });

  test("progress events drive the step states and download detail", async () => {
    const t = setup();
    await t.u.load();
    t.u.open();
    t.u.onEvent("signature");
    expect(t.states()).toEqual(["active", "todo", "todo", "todo"]);
    t.u.onEvent("download", "12 MB");
    // visual order: signature, download, checksum, install
    expect(t.states()).toEqual(["done", "active", "todo", "todo"]);
    expect(t.box.querySelectorAll<FakeElement>(".upd-detail")[1]!.textContent).toBe("12 MB");
    t.u.onEvent("checksum");
    expect(t.states()).toEqual(["done", "done", "active", "todo"]);
    expect(t.box.querySelectorAll<FakeElement>(".upd-detail")[1]!.textContent).toBe("12 MB");
    t.u.onEvent("install");
    expect(t.states()).toEqual(["done", "done", "done", "active"]);
    t.u.onEvent("done");
    expect(t.states()).toEqual(["done", "done", "done", "done"]);
  });

  test("error event reopens the dialog with the message (default text when none)", async () => {
    const t = setup();
    t.u.onEvent("error", "bad signature");
    expect(t.u.el.hidden).toBe(false);
    expect(t.box.textContent).toContain("bad signature");
    t.u.onEvent("error");
    expect(t.box.textContent).toContain("Unknown error");
  });

  test("installed (native): clears availability, announces restart, calls nativeRelaunch after a delay", async () => {
    const t = setup();
    const infos: UpdateInfo[] = [];
    t.u.onInfo = (i) => infos.push(i);
    await t.u.load();
    t.u.open();
    let relaunched = 0;
    t.u.nativeRelaunch = () => relaunched++;
    t.u.onEvent("installed", "1.1.0", "native");
    expect(infos.at(-1)).toMatchObject({ available: false, current: "1.1.0" });
    expect(t.box.querySelector(".upd-ok")!.textContent).toBe("Codeviewer 1.1.0 installed. Restarting…");
    expect(relaunched).toBe(0);
    await new Promise((r) => setTimeout(r, 700));
    expect(relaunched).toBe(1);
  });

  test("installed (server): asks the server to relaunch", async () => {
    const t = setup();
    await t.u.load();
    t.u.open();
    t.u.onEvent("installed", "1.1.0", "server");
    expect(t.box.querySelector(".upd-ok")!.textContent).toBe("Codeviewer 1.1.0 installed. Restarting…");
    expect(t.calls.at(-1)!.url).toBe("/api/update/relaunch");
    await t.flush();
  });

  test("installed (manual, or native without a handler): tells the user to restart", async () => {
    const t = setup();
    await t.u.load();
    t.u.open();
    t.u.onEvent("installed", "1.1.0", "manual");
    expect(t.box.querySelector(".upd-ok")!.textContent).toBe("Codeviewer 1.1.0 installed. Restart codeviewer to use it.");
    t.click("OK");
    expect(t.u.el.hidden).toBe(true);
    const t2 = setup();
    await t2.u.load();
    t2.u.open();
    t2.u.onEvent("installed", "1.1.0", "native");
    expect(t2.box.querySelector(".upd-ok")!.textContent).toContain("Restart codeviewer");
  });

  test("unknown phases are ignored", async () => {
    const t = setup();
    await t.u.load();
    t.u.open();
    const before = t.box.innerHTML;
    t.u.onEvent("mystery");
    expect(t.box.innerHTML).toBe(before);
  });
});
