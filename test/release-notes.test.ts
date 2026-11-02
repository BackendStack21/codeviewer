// The release commit's paragraph becomes the GitHub release notes and the update dialog's notes.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { releaseNotes } from "../scripts/release-notes.ts";
import { RELEASE_FOOTER, Updater, type Install } from "../src/server/update.ts";

const TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";

describe("releaseNotes", () => {
  test("drops the subject and trailer, unwraps a hard-wrapped paragraph, appends the footer", () => {
    const msg = [
      "Release 1.10.3",
      "",
      "Long agent sessions stay cheap: the terminal copies ASCII runs in one",
      "step, skips rows that did not change and keeps the replay ring small,",
      "so a busy session no longer slows the page down.",
      "",
      TRAILER,
      "",
    ].join("\n");
    expect(releaseNotes(msg)).toBe(
      "Long agent sessions stay cheap: the terminal copies ASCII runs in one step, skips rows that did not change and keeps the replay ring small, so a busy session no longer slows the page down.\n\n" + RELEASE_FOOTER,
    );
  });

  test("a single-line body", () => {
    expect(releaseNotes(`Release 1.10.4\n\nFull-screen programs repaint after a replay.\n\n${TRAILER}\n`)).toBe(
      `Full-screen programs repaint after a replay.\n\n${RELEASE_FOOTER}`,
    );
  });

  test("an empty body yields only the footer", () => {
    expect(releaseNotes(`Release 1.10.5\n\n${TRAILER}\n`)).toBe(RELEASE_FOOTER);
    expect(releaseNotes("Release 1.10.5\n")).toBe(RELEASE_FOOTER);
  });

  test("keeps paragraphs apart, each unwrapped, and drops Signed-off-by too", () => {
    const msg = `Release 2.0.0\n\nFirst part\nwraps here.\n\nSecond part\nalso wraps.\n\nSigned-off-by: A <a@x.y>\n${TRAILER}\n`;
    expect(releaseNotes(msg)).toBe(`First part wraps here.\n\nSecond part also wraps.\n\n${RELEASE_FOOTER}`);
  });

  test("leaves list blocks alone", () => {
    const msg = `Release 2.0.0\n\nChanges that matter\nto you:\n\n- one\n- two that is\n  continued\n\n${TRAILER}\n`;
    expect(releaseNotes(msg)).toBe(`Changes that matter to you:\n\n- one\n- two that is\n  continued\n\n${RELEASE_FOOTER}`);
  });
});

describe("release workflow", () => {
  test("generates notes with the script and publishes them from a file", async () => {
    const yml = await readFile(path.join(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
    expect(yml).toContain("scripts/release-notes.ts");
    expect(yml).toContain("--notes-file");
    expect(yml).not.toMatch(/--notes\s/);
    expect(yml).not.toContain("--notes \"");
    expect(yml).not.toMatch(/run:[^\n]*\$\{\{[^}]*(commit|message|head)/i);
  });
});

describe("Updater.check release notes", () => {
  function updater(body: string) {
    const fetchFn = (async () =>
      Response.json({ tag_name: "v1.1.0", html_url: "https://example.test/release", body, assets: [] })) as unknown as typeof fetch;
    const install: Install = { kind: "cli", target: "/nonexistent/codeviewer", asset: (v) => `codeviewer-${v}` };
    return new Updater({ version: "1.0.0", fetch: fetchFn, assetHosts: ["example.test"], publicKey: "", install });
  }

  test("strips the footer and keeps a multi-paragraph body", async () => {
    const info = await updater(`First.\n\nSecond.\n\n${RELEASE_FOOTER}`).check(true);
    expect(info.notes).toBe("First.\n\nSecond.");
    expect(info.notes).not.toContain("codeviewer.21no.de");
  });

  test("a footer-only body gives empty notes", async () => {
    expect((await updater(RELEASE_FOOTER).check(true)).notes?.trim()).toBe("");
    expect((await updater(`${RELEASE_FOOTER}\n`).check(true)).notes?.trim()).toBe("");
  });

  test("old releases with only the fixed line show no notes", async () => {
    expect((await updater(RELEASE_FOOTER).check(true)).notes ?? "").toBe("");
  });
});
