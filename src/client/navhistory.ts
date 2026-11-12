export interface NavLoc {
  path: string;
  line: number; // 1-based
  /** Set when the location was a rendered Markdown preview. */
  view?: "preview";
}

const copy = (l: NavLoc): NavLoc => (l.view ? { path: l.path, line: l.line, view: l.view } : { path: l.path, line: l.line });

/** Gives `e` the line and view of `l` (the view key is removed when `l` has none). */
const take = (e: NavLoc, l: NavLoc): void => {
  e.line = l.line;
  if (l.view) e.view = l.view;
  else delete e.view;
};

/** Browser-style back/forward list: entries plus the index of the current one. */
export class NavHistory {
  private list: NavLoc[] = [];
  private idx = -1;
  private readonly cap: number;
  private readonly near: number;

  constructor(opts?: { cap?: number; near?: number }) {
    this.cap = opts?.cap ?? 100;
    this.near = opts?.near ?? 10;
  }

  record(from: NavLoc | undefined, to: NavLoc): void {
    this.list.length = this.idx + 1;
    if (from) {
      const cur = this.list[this.idx];
      if (cur && cur.path === from.path) take(cur, from);
      else this.push(from);
    }
    const cur = this.list[this.idx];
    if (cur && cur.path === to.path && Math.abs(cur.line - to.line) <= this.near) take(cur, to);
    else this.push(to);
  }

  /**
   * `current` is where the user is now. When it is the entry's own file, the entry takes its line.
   * When it is another file (a tab chosen by hand, which is not a jump), the entry is left as it
   * is: Back first remembers that file as a new last entry, so the place it returns to is the
   * last recorded one and Forward comes back; Forward just moves on.
   */
  back(current?: NavLoc): NavLoc | undefined {
    if (!this.canBack()) return undefined;
    const cur = this.list[this.idx];
    if (current && cur && current.path !== cur.path) {
      this.list.length = this.idx + 1;
      this.push(current);
      return this.move(-1);
    }
    return this.move(-1, current);
  }

  forward(current?: NavLoc): NavLoc | undefined {
    if (!this.canForward()) return undefined;
    const cur = this.list[this.idx];
    return this.move(1, current && cur && current.path !== cur.path ? undefined : current);
  }

  canBack(): boolean {
    return this.idx > 0;
  }

  canForward(): boolean {
    return this.idx < this.list.length - 1;
  }

  drop(path: string): void {
    const kept: NavLoc[] = [];
    let newIdx = -1;
    let firstSurvivorSeen = false;
    this.list.forEach((e, i) => {
      if (e.path === path) return;
      const prev = kept[kept.length - 1];
      if (prev && prev.path === e.path && prev.line === e.line) {
        // merged into the previous survivor
      } else {
        kept.push(e);
      }
      firstSurvivorSeen = true;
      // survivors at or before the current index set the fallback; the current one wins
      if (i <= this.idx) newIdx = kept.length - 1;
    });
    if (kept.length && newIdx < 0 && firstSurvivorSeen) newIdx = 0;
    if (!kept.length) newIdx = -1;
    this.list = kept;
    this.idx = newIdx;
  }

  entries(): NavLoc[] {
    return this.list.map(copy);
  }

  index(): number {
    return this.idx;
  }

  private push(l: NavLoc): void {
    this.list.push(copy(l));
    this.idx = this.list.length - 1;
    while (this.list.length > this.cap) {
      this.list.shift();
      this.idx--;
    }
  }

  private move(d: number, current?: NavLoc): NavLoc {
    if (current) this.list[this.idx] = copy(current);
    this.idx += d;
    return copy(this.list[this.idx]!);
  }
}
