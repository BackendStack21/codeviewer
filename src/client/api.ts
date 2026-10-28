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

const q = (p: string) => encodeURIComponent(p);

async function check(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  return res;
}

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
  /** Opens an http(s) link in the user's default browser, outside the app window. */
  external: (url: string) =>
    fetch("/api/external", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }),
  /** Raw file as a blob: URL (images can't send the auth header themselves). Caller revokes it. */
  rawBlobUrl: async (path: string): Promise<string> =>
    URL.createObjectURL(await (await check(await fetch(`/api/raw?path=${q(path)}`))).blob()),
  head: async (path: string, bytes: number): Promise<Uint8Array> =>
    new Uint8Array(await (await check(await fetch(`/api/raw?path=${q(path)}&limit=${bytes}`))).arrayBuffer()),
};
