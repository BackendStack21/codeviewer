// Search worker: scans candidate files with a verified-regular-file handle and posts results.
// The user's pattern only ever runs here, so the main thread can terminate() it at any time.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { looksBinary, MAX_TEXT_BYTES, within } from "./files.ts";
import { compileQuery, matchText, MAX_TOTAL_MATCHES, type WorkerJob, type WorkerMsg } from "./search.ts";

declare var self: Worker;

function decode(buf: Uint8Array): string {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return new TextDecoder(buf[0] === 0xff ? "utf-16le" : "utf-16be").decode(buf.subarray(2));
  }
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return new TextDecoder("utf-8").decode(bom ? buf.subarray(3) : buf);
}

const post = (m: WorkerMsg) => postMessage(m);

function run({ req, cancel }: WorkerJob): void {
  const flag = new Int32Array(cancel);
  const c = compileQuery(req.q, req.opts);
  if (!c.ok) {
    post({ t: "done", files: 0, matches: 0, skipped: 0, truncated: false });
    return;
  }
  // Like the find bar (which tests line by line), ^ and $ anchor at line boundaries.
  const re = new RegExp(c.re.source, c.re.flags.includes("m") ? c.re.flags : c.re.flags + "m");
  let rootReal = req.root;
  try {
    rootReal = realpathSync(req.root);
  } catch {
    /* unreadable root: every open below fails and counts as skipped */
  }
  const seen = new Set<string>();
  let files = 0;
  let matches = 0;
  let skipped = 0;
  let truncated: false | "matches" = false;
  let buf = new Uint8Array(64 * 1024);
  for (const rel of req.files) {
    if (Atomics.load(flag, 0) === 1) return;
    if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) {
      skipped++;
      post({ t: "skip" });
      continue;
    }
    let fd = -1;
    try {
      // Containment: a symlinked parent (or file) that resolves outside the root is never opened.
      let real: string;
      try {
        real = realpathSync(path.join(rootReal, rel));
      } catch {
        continue; // gone since it was listed (deleted but still in the index): nothing was skipped
      }
      if (!within(rootReal, real)) throw new Error("skip");
      fd = openSync(path.join(rootReal, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (st.isDirectory()) continue; // submodules and nested repositories are listed as paths, not files
      if (!st.isFile() || st.size > MAX_TEXT_BYTES) throw new Error("skip");
      const id = `${st.dev}:${st.ino}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (buf.length < st.size) buf = new Uint8Array(Math.min(MAX_TEXT_BYTES, Math.max(st.size, buf.length * 2)));
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off);
        if (n === 0) break;
        off += n;
      }
      const bytes = buf.subarray(0, off);
      if (looksBinary(bytes)) throw new Error("skip");
      const r = matchText(decode(bytes), re);
      if (r.matches.length) {
        const room = MAX_TOTAL_MATCHES - matches;
        const take = r.matches.slice(0, room);
        const more = r.more + (r.matches.length - take.length);
        matches += take.length;
        files++;
        post(more ? { t: "file", path: rel, matches: take, more } : { t: "file", path: rel, matches: take });
        if (matches >= MAX_TOTAL_MATCHES) {
          truncated = "matches";
          break;
        }
      }
    } catch {
      skipped++;
      post({ t: "skip" });
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  }
  post({ t: "done", files, matches, skipped, truncated });
}

self.onmessage = (e: MessageEvent<WorkerJob>) => {
  try {
    run(e.data);
  } catch {
    post({ t: "done", files: 0, matches: 0, skipped: 0, truncated: false });
  }
};
