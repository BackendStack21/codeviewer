// Release notes from the release commit's message: the paragraph after the subject line becomes the
// GitHub release body (and so the update dialog's notes), followed by the verify line.
//
//   bun scripts/release-notes.ts [ref] > notes.md     (ref defaults to HEAD)
//
// Used by the release workflow. Warns (`::warning::`) on stderr when the commit has no body.
import { RELEASE_FOOTER } from "../src/server/update.ts";

const TRAILER = /^(co-authored-by|signed-off-by):/i;
// Lines that mean the paragraph is formatted text: list item, heading, quote, fence or indented.
const BLOCK = /^(\s|[-*+]\s|\d+[.)]\s|#|>|```|~~~)/;

/** The release notes for a full commit message. */
export function releaseNotes(message: string): string {
  const lines = message.replace(/\r\n?/g, "\n").split("\n").slice(1); // drop the subject
  while (lines.length && (!lines[lines.length - 1]!.trim() || TRAILER.test(lines[lines.length - 1]!))) lines.pop();

  const paras: string[][] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    if (!line.trim() && !fence) {
      if (cur.length) paras.push(cur);
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) paras.push(cur);

  const out = paras.map((p) => (p.some((l) => BLOCK.test(l)) ? p.join("\n") : p.map((l) => l.trim()).join(" ")));
  out.push(RELEASE_FOOTER);
  return out.join("\n\n");
}

/** What the CLI prints for `ref` in the repository at `cwd` (default: the current directory). */
export function cli(ref: string, cwd?: string): { code: number; out: string; err: string } {
  const git = Bun.spawnSync(["git", "log", "-1", "--format=%B", ref, "--"], { stderr: "pipe", cwd });
  if (git.exitCode !== 0) return { code: 1, out: "", err: `release-notes: git log failed for ${ref}: ${git.stderr.toString().trim()}\n` };
  const notes = releaseNotes(git.stdout.toString());
  const err = notes === RELEASE_FOOTER ? `::warning::The commit ${ref} has no summary paragraph: the release notes are only the verify line.\n` : "";
  return { code: 0, out: notes + "\n", err };
}

if (import.meta.main) {
  const r = cli(process.argv[2] ?? "HEAD");
  process.stderr.write(r.err);
  process.stdout.write(r.out);
  process.exit(r.code);
}
