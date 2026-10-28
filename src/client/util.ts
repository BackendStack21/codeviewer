export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? "⌘" : "Ctrl+";

type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else if (k === "html") el.innerHTML = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ESC[c]!);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

let settings: Record<string, unknown> = {};
let saveTimer = 0;

function saveSettings(keepalive = false) {
  clearTimeout(saveTimer);
  void fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings), keepalive }).catch(() => {});
}

/**
 * Settings persisted by the server (~/.config/codeviewer), so they survive relaunches of the
 * app window (which uses a throwaway browser profile and a random port).
 */
export const store = {
  async init() {
    try {
      settings = (await (await fetch("/api/settings")).json()) as Record<string, unknown>;
    } catch {
      settings = {};
    }
    window.addEventListener("pagehide", () => saveSettings(true));
  },
  get<T>(key: string, def: T): T {
    return key in settings ? (settings[key] as T) : def;
  },
  set(key: string, v: unknown) {
    settings[key] = v;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveSettings(), 300);
  },
};

/** Per-server-instance state (e.g. live terminal session ids) that only matters until the page reloads. */
export const local = {
  get<T>(key: string, def: T): T {
    try {
      const v = localStorage.getItem("cv:" + key);
      return v === null ? def : (JSON.parse(v) as T);
    } catch {
      return def;
    }
  },
  set(key: string, v: unknown) {
    try {
      localStorage.setItem("cv:" + key, JSON.stringify(v));
    } catch {}
  },
};

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t = 0;
  return (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

/** Drag a splitter: calls onMove with the pointer delta from the drag start. */
export function dragSplitter(handle: HTMLElement, axis: "x" | "y", onStart: () => number, onMove: (start: number, delta: number) => void) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const origin = axis === "x" ? e.clientX : e.clientY;
    const start = onStart();
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
    handle.classList.add("active");
    const move = (ev: PointerEvent) => onMove(start, (axis === "x" ? ev.clientX : ev.clientY) - origin);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing-x", "resizing-y");
      handle.classList.remove("active");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}
