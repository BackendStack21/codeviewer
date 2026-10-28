// Session token handling. The launch URL carries the token in its fragment (#t=…), which
// browsers never send to any server. It is moved into sessionStorage (isolated per origin,
// i.e. per port), removed from the address bar, and attached to every same-origin request
// as a header. There are no cookies: cookies are shared by every port on 127.0.0.1.

const KEY = "cv:token";

function take(): string | null {
  const m = /(?:^#|&)t=([\w-]+)/.exec(location.hash);
  if (m) {
    try {
      sessionStorage.setItem(KEY, m[1]!);
    } catch {}
    history.replaceState(null, "", location.pathname + location.search);
    return m[1]!;
  }
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const token = take();

if (token) {
  const native = window.fetch.bind(window);
  window.fetch = Object.assign(
    (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (typeof input === "string" && input.startsWith("/")) {
        const headers = new Headers(init.headers);
        headers.set("x-cv-token", token);
        init = { ...init, headers };
      }
      return native(input, init);
    },
    { preconnect: () => {} },
  ) as typeof fetch;
}

/** WebSocket URL for a server path (browsers can't set headers on WebSockets). */
export function wsUrl(path: string): string {
  const u = new URL(path, location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("t", token ?? "");
  return u.href;
}
