export interface Entry {
  name: string;
  type: "dir" | "file" | "link-broken";
  link?: true;
}

export interface Info {
  name: string;
  root: string;
  version: string;
  platform: string;
  shell: string;
  maxText: number;
}

export interface FileData {
  kind: "text" | "image" | "binary" | "dir";
  size: number;
  mtime: number;
  truncated: boolean;
  encoding: string;
  text: string;
}

export interface SearchMatch {
  line: number;
  col: number;
  len: number;
  preview: string;
  pcol: number;
}

export type SearchEvent =
  | { t: "file"; path: string; matches: SearchMatch[]; more?: number }
  | { t: "done"; files: number; matches: number; skipped: number; truncated: false | "matches" | "time"; ms: number };

export interface SearchParams {
  q: string;
  case?: boolean;
  word?: boolean;
  regex?: boolean;
  include?: string;
  exclude?: string;
  ignored?: boolean;
}

/** Splits an NDJSON stream: complete lines of `carry + chunk`, and the unfinished tail. */
export function ndjsonLines(carry: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (carry + chunk).split("\n");
  const rest = parts.pop()!;
  const lines: string[] = [];
  for (const p of parts) {
    const l = p.endsWith("\r") ? p.slice(0, -1) : p;
    if (l) lines.push(l);
  }
  return { lines, rest };
}

function parseEvent(line: string): SearchEvent | null {
  try {
    const e = JSON.parse(line) as SearchEvent | null;
    return e && typeof e === "object" && (e.t === "file" || e.t === "done") ? e : null;
  } catch {
    return null;
  }
}

const q = (p: string) => encodeURIComponent(p);

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  kind: "macos-app" | "linux-app" | "cli" | "source";
  canInstall: boolean;
  reason?: string;
  url?: string;
  notes?: string;
  checkedAt: number;
}

async function check(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  return res;
}

const check_ = (res: Response) => check(res);

export const api = {
  info: async (): Promise<Info> => (await check(await fetch("/api/info"))).json(),
  list: async (path: string): Promise<Entry[]> => (await check(await fetch(`/api/list?path=${q(path)}`))).json(),
  index: async (): Promise<string[]> => {
    const t = await (await check(await fetch("/api/index"))).text();
    return t ? t.split("\n") : [];
  },
  file: async (path: string, asText = false): Promise<FileData> => {
    const res = await check(await fetch(`/api/file?path=${q(path)}${asText ? "&text=1" : ""}`));
    const h = res.headers;
    return {
      kind: (h.get("x-cv-kind") ?? "text") as FileData["kind"],
      size: Number(h.get("x-cv-size")),
      mtime: Number(h.get("x-cv-mtime")),
      truncated: h.get("x-cv-truncated") === "1",
      encoding: h.get("x-cv-encoding") ?? "UTF-8",
      text: await res.text(),
    };
  },
  stat: async (path: string): Promise<"file" | "dir" | null> => {
    const res = await fetch(`/api/stat?path=${q(path)}`);
    return res.ok ? ((await res.json()) as { type: "file" | "dir" }).type : null;
  },
  gitStatus: async () => (await check(await fetch("/api/git/status"))).json(),
  /** HEAD version of a file; null when it isn't in HEAD (or is binary). */
  gitBase: async (path: string): Promise<string | null> => {
    const r = await fetch(`/api/git/base?path=${q(path)}`);
    return r.ok ? r.text() : null;
  },
  gitBlame: async (path: string, line: number) => {
    const r = await fetch(`/api/git/blame?path=${q(path)}&line=${line}`);
    return r.ok
      ? ((await r.json()) as { hash: string; author: string; time: number; summary: string; you: boolean; uncommitted: boolean })
      : null;
  },
  /** Update status; `check` forces a fresh look at the latest release. */
  update: async (check = false): Promise<UpdateInfo> => (await check_(await fetch(`/api/update${check ? "?check=1" : ""}`))).json(),
  updateInstall: async () => check_(await fetch("/api/update/install", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })),
  updateRelaunch: async () => check_(await fetch("/api/update/relaunch", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })),
  /** Opens an http(s) link in the user's default browser, outside the app window. */
  external: (url: string) =>
    fetch("/api/external", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }),
  /** Raw file as a blob: URL (images can't send the auth header themselves). Caller revokes it. */
  rawBlobUrl: async (path: string): Promise<string> =>
    URL.createObjectURL(await (await check(await fetch(`/api/raw?path=${q(path)}`))).blob()),
  /** Streams search events; ends quietly on abort, throws the server's error message on failure. */
  async *search(params: SearchParams, signal?: AbortSignal): AsyncGenerator<SearchEvent> {
    const sp = new URLSearchParams({ q: params.q });
    if (params.case) sp.set("case", "1");
    if (params.word) sp.set("word", "1");
    if (params.regex) sp.set("regex", "1");
    if (params.include) sp.set("include", params.include);
    if (params.exclude) sp.set("exclude", params.exclude);
    if (params.ignored) sp.set("ignored", "1");
    let res: Response;
    try {
      res = await fetch(`/api/search?${sp}`, { signal });
    } catch (e) {
      if (signal?.aborted) return;
      throw e;
    }
    await check(res);
    if (!res.body) return;
    const reader = res.body.getReader();
    const aborted = new Promise<null>((r) => {
      if (signal?.aborted) r(null);
      else signal?.addEventListener("abort", () => r(null), { once: true });
    });
    const dec = new TextDecoder();
    let rest = "";
    try {
      for (;;) {
        const r = await Promise.race([reader.read(), aborted]);
        if (!r) return;
        const split = ndjsonLines(rest, r.done ? dec.decode() + "\n" : dec.decode(r.value, { stream: true }));
        rest = r.done ? "" : split.rest;
        for (const l of split.lines) {
          const e = parseEvent(l);
          if (e) yield e;
        }
        if (r.done) return;
      }
    } finally {
      if (!signal?.aborted) void reader.cancel().catch(() => {});
    }
  },
  head: async (path: string, bytes: number): Promise<Uint8Array> =>
    new Uint8Array(await (await check(await fetch(`/api/raw?path=${q(path)}&limit=${bytes}`))).arrayBuffer()),
};
