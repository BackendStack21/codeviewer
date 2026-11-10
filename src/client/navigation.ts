import { type KeyLike, navKey } from "./keys.ts";
import { NavHistory, type NavLoc } from "./navhistory.ts";

/** What the app shell supplies; injected so the behaviour is testable without the DOM. */
export interface NavDeps {
  /** Opens a location; resolves false when the file no longer opens. */
  open(loc: NavLoc): Promise<boolean>;
  /** The location the user is at now (active text file and line), if any. */
  current(): NavLoc | undefined;
  /** Polite live-region announcement. */
  announce(msg: string): void;
  /** Toast. */
  notify(msg: string): void;
}

/** Back / Forward over a NavHistory, with recording of jumps and dropping of vanished files. */
export class Navigation {
  readonly history: NavHistory;
  private navigating = false;

  constructor(private readonly deps: NavDeps, history: NavHistory = new NavHistory()) {
    this.history = history;
  }

  /** Records a jump; ignored while Back / Forward is reopening a location. */
  record(from: NavLoc | undefined, to: NavLoc): void {
    if (!this.navigating) this.history.record(from, to);
  }

  /** Goes back or forward, skipping files that no longer open. */
  async go(dir: "back" | "forward"): Promise<void> {
    if (this.navigating) return;
    const h = this.history;
    let cur = this.deps.current();
    let stay = false;
    for (;;) {
      let loc: NavLoc | undefined;
      if (stay) loc = h.entries()[h.index()];
      else loc = dir === "back" ? h.back(cur) : h.forward(cur);
      cur = undefined;
      stay = false;
      if (!loc) {
        this.deps.notify(dir === "back" ? "No previous location" : "No next location");
        return;
      }
      this.navigating = true;
      let ok = false;
      try {
        ok = await this.deps.open(loc);
      } catch {
        ok = false;
      } finally {
        this.navigating = false;
      }
      if (ok) {
        this.deps.announce(`${dir === "back" ? "Back" : "Forward"} to ${loc.path} line ${loc.line}`);
        return;
      }
      // The file is gone: forget it and carry on in the same direction. When the index fell back
      // onto the neighbour that comes next in that direction, that neighbour is the target.
      const k = h.index();
      const m = h.entries().slice(0, k).filter((e) => e.path !== loc.path).length;
      h.drop(loc.path);
      stay = h.entries().length > 0 && (dir === "back" ? m > 0 : m === 0);
    }
  }

  /** Forgets every entry of a file (deleted on disk). */
  drop(path: string): void {
    this.history.drop(path);
  }
}

/** Routes the zoom / navigation keys; true when the event was handled. */
export function routeNavZoomKey(
  e: KeyLike,
  o: { isMac: boolean; inTerm: boolean },
  h: { navigate(dir: "back" | "forward"): void; zoom(d: number): void },
): boolean {
  const nk = navKey(e, o);
  if (nk) {
    h.navigate(nk);
    return true;
  }
  // On Linux the modifier is Ctrl, which terminal programs use: zoom stays out of a focused terminal.
  const appKey = o.isMac || !o.inTerm;
  const mod = o.isMac ? !!e.metaKey : !!e.ctrlKey;
  if (!mod || !appKey) return false;
  const k = e.key.toLowerCase();
  if (k === "=" || k === "+") h.zoom(1);
  else if (k === "-") h.zoom(-1);
  else if (k === "0") h.zoom(0);
  else return false;
  return true;
}
