import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readForView } from "../src/server/files.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test("UTF-16 BE is transcoded and UTF-8 BOM is stripped", async () => {
  const d = await mkdtemp(path.join(tmpdir(), "cv-filec-"));
  dirs.push(d);
  const be = path.join(d, "be.txt");
  await writeFile(be, Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]));
  const r1 = await readForView(be);
  expect(r1.meta.encoding).toBe("UTF-16 BE");
  expect(new TextDecoder().decode(r1.body)).toBe("hi");

  const bom = path.join(d, "bom.txt");
  await writeFile(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo")]));
  const r2 = await readForView(bom);
  expect(r2.meta.encoding).toBe("UTF-8 with BOM");
  expect(new TextDecoder().decode(r2.body)).toBe("héllo");
});
