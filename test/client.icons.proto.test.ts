import { expect, test } from "bun:test";
import { fileColor, fileIcon } from "../src/client/icons.ts";
import { languageFor } from "../src/client/highlight.ts";

// Lookups keyed by a file name must only ever find their own entries.
test("files named like Object.prototype members get the default icon and plain text", () => {
  for (const name of ["constructor", "toString", "__proto__", "a.constructor", "x.__proto__", "valueOf", "hasOwnProperty"]) {
    expect(fileColor(name)).toBe("var(--icon-file)");
    expect(fileIcon(name)).not.toContain("native code");
    expect(languageFor(name)).toBe("text");
    expect(languageFor("dir/" + name)).toBe("text");
  }
  expect(fileColor("package.json")).toBe("#7cc36a");
  expect(languageFor("a.ts")).not.toBe("text");
});
