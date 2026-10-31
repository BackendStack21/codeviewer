// Builds the throwaway demo project the landing-page screenshots are taken in (scripts/shots.ts).
// Everything is deterministic: a fixed neutral author and dates, a `main` branch, a feature branch
// ahead of it, and uncommitted edits, so every git indicator has something to show.
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const AUTHOR = { name: "Ada Park", email: "ada@example.com" };
const AUTHOR_2 = { name: "Sam Rivera", email: "sam@example.com" };

const README = `# Harbor

A tiny, dependency-free job queue for TypeScript services. Jobs are plain functions; Harbor
retries them with backoff, keeps an in-memory cache of results and exposes a small HTTP API.

![Build status](https://img.shields.io/badge/build-passing-brightgreen)

## Features

| Feature | Status | Notes |
| --- | :---: | --- |
| Retries with backoff | ✅ | Exponential, capped at 30 s |
| Result cache | ✅ | LRU with per-entry TTL |
| HTTP API | ✅ | \`GET /jobs\`, \`POST /jobs\` |
| Metrics | 🚧 | Counters only, see \`src/metrics.ts\` |

## Roadmap

- [x] Exponential backoff
- [x] TTL eviction for the cache
- [ ] Rate limiting per queue
- [ ] Persistent storage adapter

## Quick start

\`\`\`ts
import { Queue } from "./src/queue";

const q = new Queue({ concurrency: 4 });
q.add("resize", async (img: string) => resize(img, 640));
await q.drain();
\`\`\`

> Harbor is a demo project used for Codeviewer's screenshots. Read the
> [architecture notes](docs/ARCHITECTURE.md) for the design.
`;

const ARCH = `# Architecture

Harbor has three parts: the **queue**, the **cache** and the **router**.

## Queue

Jobs enter through \`Queue.add\`, wait in a FIFO and run with bounded concurrency.

## Cache

An LRU map keyed by job id. Entries expire after their TTL.

## Router

A thin layer over \`Bun.serve\` that maps HTTP routes to queue operations.
`;

const QUEUE_V1 = `import { Cache } from "./cache";

export type Job<T = unknown> = (input: T) => Promise<unknown>;

export interface QueueOptions {
  concurrency: number;
  retries?: number;
}

/** A FIFO of named jobs with bounded concurrency. */
export class Queue {
  private pending: Array<{ name: string; run: () => Promise<unknown> }> = [];
  private running = 0;
  readonly results = new Cache<string, unknown>(500);

  constructor(private opts: QueueOptions) {}

  add<T>(name: string, job: Job<T>, input?: T): void {
    this.pending.push({ name, run: () => job(input as T) });
    this.pump();
  }

  private pump(): void {
    while (this.running < this.opts.concurrency && this.pending.length) {
      const next = this.pending.shift()!;
      this.running++;
      next.run().then((value) => this.results.set(next.name, value)).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  async drain(): Promise<void> {
    while (this.running || this.pending.length) await new Promise((r) => setTimeout(r, 5));
  }
}
`;

const QUEUE_V2 = QUEUE_V1.replace(
  `  private pump(): void {`,
  `  /** Retries a job with exponential backoff, capped at 30 seconds. */
  private async attempt(run: () => Promise<unknown>, tries = this.opts.retries ?? 3): Promise<unknown> {
    for (let i = 0; ; i++) {
      try {
        return await run();
      } catch (err) {
        if (i >= tries) throw err;
        await sleep(Math.min(30_000, 100 * 2 ** i));
      }
    }
  }

  private pump(): void {`,
).replace(`next.run().then(`, `this.attempt(next.run).then(`).replace(
  `import { Cache } from "./cache";`,
  `import { Cache } from "./cache";\nimport { sleep } from "./util/time";`,
);

const CACHE_V1 = `/** A least-recently-used cache. */
export class Cache<K, V> {
  private map = new Map<K, V>();

  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as K);
  }

  get size(): number {
    return this.map.size;
  }
}
`;

const CACHE_V2 = `/** A least-recently-used cache with optional per-entry expiry. */
export class Cache<K, V> {
  private map = new Map<K, { value: V; expires: number }>();

  constructor(
    private capacity: number,
    private ttlMs = Infinity,
  ) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    if (entry.expires < Date.now()) return undefined;
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs = this.ttlMs): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    if (this.map.size > this.capacity) this.evict();
  }

  /** Drops expired entries first, then the least recently used one. */
  evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) if (entry.expires < now) this.map.delete(key);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as K);
  }

  get size(): number {
    return this.map.size;
  }
}
`;

const CACHE_V3 = CACHE_V2.replace(
  `  get size(): number {`,
  `  /** Removes every entry. */
  clear(): void {
    this.map.clear();
  }

  get size(): number {`,
);

const ROUTER_V1 = `import { Queue } from "./queue";

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function createRouter(queue: Queue) {
  const routes = new Map<string, Handler>();

  routes.set("GET /health", () => json({ ok: true }));

  routes.set("GET /jobs", () => json({ cached: queue.results.size }));

  routes.set("POST /jobs", async (req) => {
    const body = (await req.json()) as { name?: string };
    if (!body.name) return json({ error: "name is required" }, 400);
    queue.add(body.name, async () => ({ done: true }));
    return json({ queued: body.name }, 202);
  });

  return (req: Request) => {
    const url = new URL(req.url);
    const handler = routes.get(\`\${req.method} \${url.pathname}\`);
    return handler ? handler(req, url) : json({ error: "not found" }, 404);
  };
}
`;

// Uncommitted: a validation tweak, a new route, and a removed health check.
const ROUTER_WORKING = ROUTER_V1.replace(
  `  routes.set("GET /health", () => json({ ok: true }));\n\n`,
  ``,
)
  .replace(
    `    if (!body.name) return json({ error: "name is required" }, 400);`,
    `    if (!body.name || body.name.length > 64) {\n      return json({ error: "name must be 1-64 characters" }, 400);\n    }`,
  )
  .replace(
    `  return (req: Request) => {`,
    `  routes.set("DELETE /jobs", () => {\n    queue.results.clear();\n    return json({ cleared: true });\n  });\n\n  return (req: Request) => {`,
  );

const SERVER = `import { Queue } from "./queue";
import { createRouter } from "./router";

const queue = new Queue({ concurrency: Number(process.env.CONCURRENCY ?? 4), retries: 3 });
const port = Number(process.env.PORT ?? 8080);

Bun.serve({ port, fetch: createRouter(queue) });
console.log(\`harbor listening on :\${port}\`);
`;

const TIME = `export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function formatDuration(ms: number): string {
  if (ms < 1000) return \`\${ms} ms\`;
  const s = ms / 1000;
  return s < 60 ? \`\${s.toFixed(1)} s\` : \`\${Math.floor(s / 60)} min \${Math.round(s % 60)} s\`;
}
`;

const METRICS = `/** Process-wide counters, exported as plain text. */
export class Metrics {
  private counters = new Map<string, number>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  render(): string {
    return [...this.counters].map(([k, v]) => \`harbor_\${k} \${v}\`).join("\\n");
  }
}

export const metrics = new Metrics();
`;

const RATE_LIMIT = `/** A token bucket: \`capacity\` requests, refilled at \`perSecond\`. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(
    private capacity: number,
    private perSecond: number,
  ) {
    this.tokens = capacity;
  }

  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}
`;

const TEST = `import { expect, test } from "bun:test";
import { Cache } from "../src/cache";

test("evicts the least recently used entry", () => {
  const c = new Cache<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  expect(c.get("b")).toBeUndefined();
  expect(c.get("a")).toBe(1);
});
`;

const PKG = `{
  "name": "harbor",
  "version": "0.4.0",
  "type": "module",
  "scripts": {
    "start": "bun src/server.ts",
    "test": "bun test"
  }
}
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "strict": true
  }
}
`;

const OLD_NOTES = `# Notes

Superseded by docs/ARCHITECTURE.md.
`;

/** Creates the demo repository in `dir` (which is emptied first). */
export async function buildDemoRepo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let clock = Date.UTC(2026, 9, 12, 9, 30) / 1000;

  const write = async (file: string, text: string) => {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  };
  const git = async (args: string[], who = AUTHOR) => {
    const date = `${clock} +0000`;
    const p = Bun.spawn(["git", ...args], {
      cwd: dir,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: who.name,
        GIT_AUTHOR_EMAIL: who.email,
        GIT_COMMITTER_NAME: who.name,
        GIT_COMMITTER_EMAIL: who.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
    if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  };
  const commit = async (message: string, who = AUTHOR) => {
    await git(["add", "-A"], who);
    await git(["commit", "-q", "-m", message], who);
    clock += 3600 * 26;
  };

  await git(["init", "-q", "-b", "main"]);
  await write(".gitignore", "node_modules/\ndist/\n*.log\n");
  await write("package.json", PKG);
  await write("tsconfig.json", TSCONFIG);
  await write("README.md", README);
  await write("NOTES.md", OLD_NOTES);
  await write("src/cache.ts", CACHE_V1);
  await write("src/queue.ts", QUEUE_V1);
  await commit("Initial queue and LRU cache");
  await write("src/router.ts", ROUTER_V1);
  await write("src/server.ts", SERVER);
  await commit("Add the HTTP router and server", AUTHOR_2);
  await write("src/util/time.ts", TIME);
  await write("src/queue.ts", QUEUE_V2);
  await commit("Retry failed jobs with exponential backoff");
  await write("test/cache.test.ts", TEST);
  // A small binary file (a made-up snapshot format) for the hex dump.
  const snap = new Uint8Array(320);
  snap.set(new TextEncoder().encode("HRBSNAP\x01queue=resize;retries=3;"), 0);
  for (let i = 40; i < snap.length; i++) snap[i] = (i * 37 + 11) & 0xff;
  await mkdir(path.join(dir, "data"), { recursive: true });
  await writeFile(path.join(dir, "data/queue.snap"), snap);
  await write("docs/ARCHITECTURE.md", ARCH);
  await copyFile(path.resolve(import.meta.dir, "../docs/assets/icon-256.png"), path.join(dir, "docs/logo.png"));
  await commit("Document the architecture and test the cache", AUTHOR_2);

  // The feature branch: two commits ahead of main.
  await git(["checkout", "-q", "-b", "feature/cache-ttl"]);
  await write("src/cache.ts", CACHE_V2);
  await commit("Expire cache entries after a TTL");
  await write("src/metrics.ts", METRICS);
  await write("src/cache.ts", CACHE_V3);
  await commit("Add Cache.clear and process metrics", AUTHOR_2);

  // Uncommitted work: modified, staged-new, untracked and deleted files, plus ignored output.
  await write("src/router.ts", ROUTER_WORKING);
  await write("src/rate-limit.ts", RATE_LIMIT);
  await write("src/health.ts", `export const health = () => ({ ok: true, uptime: process.uptime() });\n`);
  await git(["add", "src/health.ts"]);
  await rm(path.join(dir, "NOTES.md"));
  await write("dist/server.js", "// build output\n");
  await write("harbor.log", "harbor listening on :8080\n");
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: bun scripts/demo-repo.ts <dir>");
  // buildDemoRepo empties its directory: never point it at something that already has content.
  const existing = await readdir(path.resolve(dir)).catch(() => []);
  if (existing.length) throw new Error(`${dir} is not empty; pass a new or empty directory`);
  await buildDemoRepo(path.resolve(dir));
  console.log(`demo repo ready in ${dir}`);
}
