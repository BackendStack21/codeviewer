import { describe, expect, test } from "bun:test";
import { compileQuery, matchText } from "../src/server/search.ts";

const MODULE = new URL("../src/server/search.ts", import.meta.url).pathname;

/** Runs matchText in a child process so a non-terminating loop fails by timeout instead of hanging the suite. */
async function boundedMatch(text: string, q: string, o: object): Promise<{ done: boolean; matches?: any[] }> {
  const script = `
    import { compileQuery, matchText } from ${JSON.stringify(MODULE)};
    const c = compileQuery(${JSON.stringify(q)}, ${JSON.stringify(o)});
    if (!c.ok) throw new Error("compile");
    console.log(JSON.stringify(matchText(${JSON.stringify(text)}, c.re).matches));
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), 3000);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) return { done: false };
  return { done: true, matches: JSON.parse(out) };
}

describe("matchText terminates on zero-width matches beside surrogate pairs", () => {
  const cases: [string, string, object, number[]][] = [
    ["a😀b", "x*", { regex: true }, []],
    ["😀a", "x*", { regex: true }, []],
    ["xa😀", "a?", { regex: true }, [1]],
  ];
  for (const [text, q, o, cols] of cases) {
    test(JSON.stringify(text) + " with /" + q + "/", async () => {
      const r = await boundedMatch(text, q, o);
      expect(r.done).toBe(true);
      expect(r.matches?.map((m) => m.col)).toEqual(cols);
    }, 10000);
  }
});

describe("previews never end or start on a lone surrogate", () => {
  test("window end does not split an astral character", () => {
    const line = "a".repeat(30) + "N" + "b".repeat(168) + "😀" + "c".repeat(50);
    const c = compileQuery("N", { case: true });
    if (!c.ok) throw new Error("compile");
    const m = matchText(line, c.re).matches[0]!;
    const last = m.preview.charCodeAt(m.preview.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(m.preview.slice(m.pcol, m.pcol + m.len)).toBe("N");
  });
});
