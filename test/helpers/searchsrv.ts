import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, type ServeOptions } from "../../src/server/http.ts";

export const token = "T".repeat(43);

export interface Ev {
  t: string;
  [k: string]: unknown;
}

export interface Fx {
  dir: string;
  base: string;
  stop(): Promise<void>;
  /** Fetches /api/search and parses the NDJSON body (bounded by `ms`). */
  search(params: Record<string, string>, ms?: number): Promise<{ status: number; type: string; text: string; events: Ev[] }>;
  raw(params: Record<string, string>, init?: RequestInit): Promise<Response>;
}

export async function makeServer(setup: (dir: string) => Promise<void>, extra: Partial<ServeOptions> = {}): Promise<Fx> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cv-search-")));
  await setup(dir);
  const app = startServer({ root: dir, port: 0, host: "127.0.0.1", shell: "/bin/sh", token, openExternal: () => {}, ...extra });
  const base = `http://127.0.0.1:${app.server.port}`;
  const url = (p: Record<string, string>) => `${base}/api/search?${new URLSearchParams(p)}`;
  const raw: Fx["raw"] = (p, init) => fetch(url(p), { ...init, headers: { "x-cv-token": token } });
  return {
    dir,
    base,
    raw,
    async search(p, ms = 20_000) {
      const r = await raw(p, { signal: AbortSignal.timeout(ms) });
      const text = await r.text();
      const events: Ev[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          /* not NDJSON (e.g. an error body) */
        }
      }
      return { status: r.status, type: r.headers.get("content-type") ?? "", text, events };
    },
    async stop() {
      app.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const done = (evs: Ev[]) => evs.find((e) => e.t === "done") as
  | { t: "done"; files: number; matches: number; skipped: number; truncated: false | "matches" | "time"; ms: number }
  | undefined;
export const files = (evs: Ev[]) => evs.filter((e) => e.t === "file") as unknown as { t: "file"; path: string; matches: { line: number; col: number; len: number; preview: string; pcol: number }[]; more?: number }[];
