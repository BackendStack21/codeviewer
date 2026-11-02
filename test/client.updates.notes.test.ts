import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { installDom, mockFetch, uninstallDom, type FakeElement } from "./helpers/fakedom.ts";
import type { UpdateInfo } from "../src/client/api.ts";

let U: typeof import("../src/client/updates.ts");
beforeAll(async () => {
  installDom();
  U = await import("../src/client/updates.ts");
});
afterAll(() => uninstallDom());
let restore = () => {};
afterEach(() => restore());

test("the dialog shows no notes box for empty notes and keeps paragraphs for real ones", async () => {
  for (const [notes, expected] of [["", null], [" \n ", null], ["One.\n\nTwo.", "One.\n\nTwo."]] as const) {
    const info: UpdateInfo = { current: "1.0.0", latest: "1.1.0", available: true, kind: "macos-app", canInstall: true, checkedAt: 1, notes };
    const m = mockFetch(() => Response.json(info));
    restore = m.restore;
    const u = new U.Updates();
    await u.load();
    u.open();
    const box = u.el.querySelector<FakeElement>(".upd-notes");
    expect(box ? box.textContent : null).toBe(expected);
    restore();
  }
});
