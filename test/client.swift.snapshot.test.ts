import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// AC-17: the snapshotrect handler replies with base64 PNG and never touches the pasteboard; copyimage keeps writing it.
const path = new URL("../packaging/macos/main.swift", import.meta.url).pathname;
const src = readFileSync(path, "utf8");

function block(from: string): string {
  const start = src.indexOf(`if t == "${from}" {`);
  if (start < 0) throw new Error(`no ${from} handler`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unbalanced");
}

describe("macOS snapshot handlers (AC-17)", () => {
  test("snapshotrect replies with base64 PNG and does not use the pasteboard", () => {
    const h = block("snapshotrect");
    expect(h).toContain("reply(");
    expect(h).toContain("base64EncodedString");
    expect(h).not.toContain("pb.setData");
    expect(h).not.toContain("clearContents");
    expect(h).not.toContain("NSPasteboard");
  });
  test("copyimage still writes the pasteboard", () => {
    const h = block("copyimage");
    expect(h).toContain("clearContents");
    expect(h).toContain("pb.setData");
  });
  test("main.swift parses", async () => {
    const swiftc = Bun.which("swiftc");
    if (!swiftc) return;
    const p = Bun.spawn([swiftc, "-parse", path], { stdout: "ignore", stderr: "pipe" });
    expect(await p.exited).toBe(0);
  });
});
