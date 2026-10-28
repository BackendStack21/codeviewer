// Renders packaging/og.html to docs/assets/og.png, the 1200x630 Open Graph / Twitter card image.
// macOS only (WebKit via packaging/macos/snapshot.swift). The PNG is committed, so this only needs
// re-running when the card's design or the screenshot changes.
//
//   bun run og
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const out = path.join(root, "docs/assets/og.png");

const sh = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} failed`);
};

const work = await mkdtemp(path.join(os.tmpdir(), "cv-og-"));
try {
  const tool = path.join(work, "snapshot");
  await sh(["xcrun", "swiftc", "-O", path.join(root, "packaging/macos/snapshot.swift"), "-o", tool, "-framework", "Cocoa", "-framework", "WebKit"]);
  await sh([tool, path.join(root, "packaging/og.html"), out, "1200", "630"]);
  // WebKit snapshots at the display's scale (2x on Retina); social cards want exactly 1200x630.
  await sh(["sips", "-z", "630", "1200", out, "--out", out]);
  console.log("og       docs/assets/og.png (1200x630)");
} finally {
  await rm(work, { recursive: true, force: true });
}
