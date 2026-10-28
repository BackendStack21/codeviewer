// Line diff (Myers' O(ND) algorithm) for the git gutter. Common prefixes/suffixes are
// trimmed first, so typical edits are near-linear; a pathological middle section beyond
// MAX_D edits collapses into one "modified" hunk rather than burning time.

/** Replace old lines [a0, a1) with new lines [b0, b1). */
export interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

const MAX_D = 2000;

export function diffLines(a: string[], b: string[]): Hunk[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const ids = new Map<string, number>();
  const id = (x: string) => {
    let v = ids.get(x);
    if (v === undefined) ids.set(x, (v = ids.size));
    return v;
  };
  const A = Int32Array.from(a.slice(s, ea), id);
  const B = Int32Array.from(b.slice(s, eb), id);
  const hunks = myers(A, B) ?? [{ a0: 0, a1: A.length, b0: 0, b1: B.length }];
  return hunks.map((h) => ({ a0: h.a0 + s, a1: h.a1 + s, b0: h.b0 + s, b1: h.b1 + s }));
}

function myers(A: Int32Array, B: Int32Array): Hunk[] | null {
  const n = A.length;
  const m = B.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ a0: 0, a1: n, b0: 0, b1: m }];
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_D) return null;
    // Snapshot of v after round d-1, for k in [-d-1, d+1] (index k + d + 1).
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }

  // Walk back through the snapshots, marking deleted (A) and inserted (B) lines.
  const del = new Uint8Array(n);
  const ins = new Uint8Array(m);
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const snap = trace[d]!;
    const at = (k: number) => snap[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    if (down) ins[py] = 1;
    else del[px] = 1;
    x = px;
    y = py;
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && !del[i] && !ins[j]) {
      i++;
      j++;
      continue;
    }
    const a0 = i;
    const b0 = j;
    while ((i < n && del[i]) || (j < m && ins[j])) {
      while (i < n && del[i]) i++;
      while (j < m && ins[j]) j++;
    }
    if (i === a0 && j === b0) break; // defensive: never loop without progress
    hunks.push({ a0, a1: i, b0, b1: j });
  }
  return hunks;
}

export const ADDED = 1;
export const MODIFIED = 2;
export const DELETED_BELOW = 4; // lines were removed after this line
export const DELETED_ABOVE = 8; // lines were removed before this (first) line

/** Per-line gutter flags for the new text, from hunks. */
export function gutterMarks(hunks: Hunk[], lines: number): Uint8Array {
  const marks = new Uint8Array(lines);
  for (const h of hunks) {
    if (h.b1 > h.b0) marks.fill(h.a1 > h.a0 ? MODIFIED : ADDED, h.b0, h.b1);
    else if (h.b0 > 0) marks[h.b0 - 1]! |= DELETED_BELOW;
    else if (lines > 0) marks[0]! |= DELETED_ABOVE;
  }
  return marks;
}
