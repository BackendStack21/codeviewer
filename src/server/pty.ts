import type { ServerWebSocket } from "bun";

/** Output kept per session so a reloaded page can repaint the screen. */
const REPLAY_BYTES = 512 * 1024;
/** Output is coalesced into one WebSocket frame per FLUSH_MS (or per FLUSH_BYTES). */
const FLUSH_MS = 4;
const FLUSH_BYTES = 64 * 1024;
/** Above this much unsent data the client is lagging: stop streaming, resync on drain. */
const HIGH_WATER = 8 * 1024 * 1024;
/** A shell that exits while nobody is attached (page reload) is kept this long for its exit notice. */
const EXIT_GRACE_MS = 60_000;
/**
 * How long the PTY stays one row shorter when asking a TUI to repaint. Two resizes in a row reach
 * Claude Code 2.1.316 as no change at all; 120 ms apart they repaint the whole screen (measured).
 */
const REPAINT_NUDGE_MS = 150;
/** Live shells per server (each holds a PTY, a process group and a 512 KB replay ring). */
const MAX_SESSIONS = 64;

/** Private modes that change how input/output must be interpreted; restored on replay. */
const TRACKED = [1, 25, 1000, 1002, 1003, 1004, 1006, 2004, 47, 1047, 1049];
/** Parser states, as in the client's parser (src/client/term/terminal.ts, `feed`). */
const enum P {
  Ground,
  Esc,
  EscInter,
  Csi,
  CsiIgnore,
  Osc,
  OscEsc,
  Str,
  StrEsc,
}

/** A ModeTracker's state at one point of the stream (stored with each replay chunk). */
export interface TrackerState {
  modes: [number, boolean][];
  st: P;
  prefix: string;
  inter: string;
  params: number[];
  cur: number;
  sub: boolean;
}

/**
 * Follows DECSET/DECRST of the TRACKED modes exactly as the client's parser does: UTF-8 decoded
 * first, C1 controls only in the ground state, nothing inside OSC/DCS/SOS/PM/APC strings, ESC
 * restarting a sequence, CAN/SUB aborting one, a prefix after parameters ignoring the sequence,
 * RIS and DECSTR resetting. A regex over the bytes disagreed with the client (a C1 CSI right after
 * ESC, or inside a string, switched bracketed paste off in the replay prefix only), so after a
 * reload a pasted command ran line by line.
 */
export class ModeTracker {
  readonly modes = new Map<number, boolean>();
  private st = P.Ground;
  private prefix = "";
  private inter = "";
  private params: number[] = [];
  private cur = -1;
  private sub = false;
  private dec = new TextDecoder("utf-8");

  static from(s: TrackerState): ModeTracker {
    const t = new ModeTracker();
    for (const [n, on] of s.modes) t.modes.set(n, on);
    t.st = s.st;
    t.prefix = s.prefix;
    t.inter = s.inter;
    t.params = [...s.params];
    t.cur = s.cur;
    t.sub = s.sub;
    return t;
  }

  state(): TrackerState {
    return { modes: [...this.modes], st: this.st, prefix: this.prefix, inter: this.inter, params: [...this.params], cur: this.cur, sub: this.sub };
  }

  /** Feeds output bytes (UTF-8, split anywhere); true when a tracked mode changed. */
  write(data: Uint8Array): boolean {
    return this.text(this.dec.decode(data, { stream: true }));
  }

  /** Feeds decoded text; true when a tracked mode changed. */
  text(s: string): boolean {
    let changed = false;
    for (let i = 0; i < s.length; i++) if (this.feed(s.charCodeAt(i), s[i]!)) changed = true;
    return changed;
  }

  private feed(c: number, ch: string): boolean {
    if (c === 0x18 || c === 0x1a) {
      this.st = P.Ground;
      return false;
    }
    if (c < 0x20 && this.st !== P.Osc && this.st !== P.Str) {
      if (c === 0x1b && this.st !== P.OscEsc && this.st !== P.StrEsc) {
        this.st = P.Esc;
        this.inter = "";
      }
      return false; // other C0 controls are executed and leave the state alone
    }
    // DEL is ignored inside sequences and is data in strings, as in the client.
    if (c === 0x7f) return false;
    switch (this.st) {
      case P.Ground:
        if (c === 0x9b) this.csiStart();
        else if (c === 0x9d) this.st = P.Osc;
        else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) this.st = P.Str;
        return false;
      case P.Esc:
        return this.escape(c, ch);
      case P.EscInter:
        if (c >= 0x20 && c <= 0x2f) {
          this.inter += ch;
          return false;
        }
        this.st = P.Ground;
        return this.escDispatch(ch);
      case P.Csi:
        return this.csiChar(c, ch);
      case P.CsiIgnore:
        if (c >= 0x40 && c <= 0x7e) this.st = P.Ground;
        return false;
      case P.Osc:
        if (c === 0x07 || c === 0x9c) this.st = P.Ground;
        else if (c === 0x1b) this.st = P.OscEsc;
        return false;
      case P.Str:
        if (c === 0x1b) this.st = P.StrEsc;
        else if (c === 0x07 || c === 0x9c) this.st = P.Ground;
        return false;
      case P.OscEsc:
      case P.StrEsc:
        if (c === 0x5c) {
          this.st = P.Ground;
          return false;
        }
        this.st = P.Esc;
        return this.escape(c, ch);
    }
    return false;
  }

  private escape(c: number, ch: string): boolean {
    if (c === 0x5b) this.csiStart();
    else if (c === 0x5d) this.st = P.Osc;
    else if (c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) this.st = P.Str;
    else if (c >= 0x20 && c <= 0x2f) {
      this.inter = ch;
      this.st = P.EscInter;
    } else {
      this.st = P.Ground;
      return this.escDispatch(ch);
    }
    return false;
  }

  /** ESC c (RIS) resets every mode. */
  private escDispatch(ch: string): boolean {
    const inter = this.inter;
    this.inter = "";
    if (inter || ch !== "c" || !this.modes.size) return false;
    this.modes.clear();
    return true;
  }

  private csiStart() {
    this.st = P.Csi;
    this.prefix = "";
    this.inter = "";
    this.params = [];
    this.cur = -1;
    this.sub = false;
  }

  private csiChar(c: number, ch: string): boolean {
    if (c >= 0x30 && c <= 0x39) {
      if (!this.sub) this.cur = Math.min(0xffff, (this.cur < 0 ? 0 : this.cur) * 10 + (c - 0x30));
    } else if (c === 0x3b) {
      this.params.push(this.cur);
      this.cur = -1;
      this.sub = false;
    } else if (c === 0x3a) this.sub = true; // sub-parameters: the mode is the first number
    else if (c >= 0x3c && c <= 0x3f) {
      if (this.params.length || this.cur >= 0) this.st = P.CsiIgnore;
      else this.prefix += ch;
    } else if (c >= 0x20 && c <= 0x2f) this.inter += ch;
    else if (c >= 0x40 && c <= 0x7e) {
      this.params.push(this.cur);
      this.st = P.Ground;
      return this.dispatch(ch);
    } else this.st = P.CsiIgnore;
    return false;
  }

  private dispatch(f: string): boolean {
    let changed = false;
    if (this.inter === "!" && f === "p" && !this.prefix) {
      // DECSTR: of the tracked modes, cursor keys and cursor visibility go back to their defaults.
      for (const n of [1, 25]) if (this.modes.delete(n)) changed = true;
      return changed;
    }
    if (this.inter || this.prefix !== "?" || (f !== "h" && f !== "l")) return false;
    const on = f === "h";
    for (const n of this.params) {
      if (n === 9 || n === 1000 || n === 1002 || n === 1003) {
        // One mouse mode at a time, like the client: setting one replaces the others, resetting
        // any of them turns reporting off (9, X10, reports like 1000).
        const m = n === 9 ? 1000 : n;
        for (const k of [1000, 1002, 1003]) if ((k !== m || !on) && this.modes.delete(k)) changed = true;
        if (on && !this.modes.get(m)) {
          this.modes.set(m, true);
          changed = true;
        }
        continue;
      }
      if (!TRACKED.includes(n)) continue;
      if (n === 47 || n === 1047 || n === 1049) {
        for (const k of [47, 1047, 1049]) if (k !== n && this.modes.delete(k)) changed = true;
      }
      if (this.modes.get(n) !== on) changed = true;
      this.modes.set(n, on);
    }
    return changed;
  }
}

/** The prefix that restores `modes` on a fresh terminal (a hidden cursor is the one "off" that differs from the default). */
export function modesPrefix(modes: Map<number, boolean>): string {
  let str = "";
  for (const [n, on] of modes) {
    if (on) str += `\x1b[?${n}h`;
    else if (n === 25) str += "\x1b[?25l";
  }
  return str;
}

export interface PtyOptions {
  shell: string;
  cwd: string;
  env: Record<string, string>;
}

export interface PtySocketData {
  kind: "pty";
  id: string;
  cols: number;
  rows: number;
}

/**
 * A shell running on a real pseudo-terminal (Bun.spawn + `terminal`).
 * Sessions outlive their WebSocket so that reloading the UI does not kill a
 * running agent; the last REPLAY_BYTES of output are replayed on reattach.
 */
class PtySession {
  private proc: ReturnType<typeof Bun.spawn>;
  private term: { write(d: string | Uint8Array): void; resize(c: number, r: number): void; close(): void };
  /** Replay ring: each chunk remembers the mode-restoring prefix in effect before it. */
  /** Replay ring: each chunk remembers the mode tracker's state before it. */
  private chunks: { data: Uint8Array; state: TrackerState }[] = [];
  private bytes = 0;
  /** The ring has dropped output, so a replay no longer holds everything since the session began. */
  private ringTrimmed = false;
  private size: { cols: number; rows: number };
  private nudge: ReturnType<typeof setTimeout> | null = null;
  private tracker = new ModeTracker();
  private get modes() {
    return this.tracker.modes;
  }
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lagging = false;
  ws: ServerWebSocket<PtySocketData> | null = null;
  exited: number | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: string,
    opts: PtyOptions,
    cols: number,
    rows: number,
    private onGone: (id: string) => void,
  ) {
    this.size = { cols, rows };
    this.proc = Bun.spawn([opts.shell, "-l"], {
      cwd: opts.cwd,
      env: opts.env,
      terminal: {
        cols,
        rows,
        data: (_t: unknown, data: Uint8Array) => this.output(data),
      },
    } as Parameters<typeof Bun.spawn>[1]);
    this.term = (this.proc as unknown as { terminal: PtySession["term"] }).terminal;
    this.proc.exited.then((code) => {
      this.exited = code;
      this.endNudge();
      if (!this.ws) {
        // Nobody attached (page reload mid-exit): keep the final output and exit code for the
        // next attach, unless no one comes back within the grace period.
        this.grace = setTimeout(() => this.onGone(this.id), EXIT_GRACE_MS);
        this.grace.unref?.();
        return;
      }
      // Deliver the last output before the exit notice; a lagging client gets it via the replay ring.
      if (this.lagging) this.sendReplay(this.ws);
      else this.flush();
      this.finish(this.ws);
    });
  }

  /** Exit notice, then the socket is closed and the session forgotten. */
  private finish(ws: ServerWebSocket<PtySocketData>) {
    ws.send(JSON.stringify({ t: "exit", code: this.exited }));
    ws.close(1000, "exited");
    this.onGone(this.id);
  }

  private output(data: Uint8Array) {
    const copy = data.slice();
    this.chunks.push({ data: copy, state: this.tracker.state() });
    this.bytes += copy.length;
    while (this.bytes > REPLAY_BYTES && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.data.length;
      this.ringTrimmed = true;
    }
    this.trackModes(copy);
    if (!this.ws || this.lagging) return;
    this.pending.push(copy);
    this.pendingBytes += copy.length;
    if (this.pendingBytes >= FLUSH_BYTES) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  /**
   * Remembers DECSET/DECRST of tracked modes. A sequence may straddle chunks: the tail from the last
   * escape is carried into the next one (re-applying a complete one there is harmless: same order).
   */
  private trackModes(data: Uint8Array) {
    this.tracker.write(data);
  }

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const ws = this.ws;
    if (!ws || !this.pending.length) return;
    const frame = this.pending.length === 1 ? this.pending[0]! : new Uint8Array(Bun.concatArrayBuffers(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
    ws.sendBinary(frame);
    // Backpressure: a tab that can't keep up stops receiving the live stream and is
    // resynchronized from the replay buffer once its socket drains.
    if (ws.getBufferedAmount() > HIGH_WATER) this.lagging = true;
  }

  /** Called when the socket's send buffer drained. */
  drained() {
    if (!this.lagging || !this.ws || this.ws.getBufferedAmount() > HIGH_WATER / 4) return;
    this.lagging = false;
    this.sendReplay(this.ws);
    this.requestRepaint();
  }

  /**
   * Full-screen TUIs send cell diffs against what they drew earlier, so once that first paint has
   * left the ring a replay rebuilds a mostly blank screen (Claude Code: 1 row of 31). Only the
   * program can redraw it, and it does so when its size changes. A shell prompt is left alone: the
   * normal screen replays fine as plain text, and a resize would only reprint the prompt.
   */
  private requestRepaint() {
    const alt = this.modes.get(1049) || this.modes.get(1047) || this.modes.get(47);
    if (!this.ringTrimmed || !alt || this.nudge || this.exited !== null || this.size.rows < 2) return;
    this.resizePty(this.size.cols, this.size.rows - 1);
    this.nudge = setTimeout(() => {
      this.nudge = null;
      this.resizePty(this.size.cols, this.size.rows);
    }, REPAINT_NUDGE_MS);
    this.nudge.unref?.();
  }

  private endNudge() {
    if (this.nudge) clearTimeout(this.nudge);
    this.nudge = null;
  }

  /** Mode prefix + the retained tail, starting at a line boundary when history was trimmed. */
  private sendReplay(ws: ServerWebSocket<PtySocketData>) {
    if (!this.chunks.length) return;
    const first = this.chunks[0]!;
    let head = first.data;
    const t = ModeTracker.from(first.state);
    if (this.ringTrimmed) {
      // History was trimmed: the first chunk may start mid-escape or mid-UTF-8.
      const nl = head.indexOf(0x0a);
      if (nl >= 0) {
        // The skipped bytes may change modes (a TUI exiting): the prefix must include them.
        t.write(head.subarray(0, nl + 1));
        head = head.subarray(nl + 1);
      }
    }
    const prefix = modesPrefix(t.modes);
    const parts = [new TextEncoder().encode(prefix), head, ...this.chunks.slice(1).map((c) => c.data)];
    ws.send(JSON.stringify({ t: "replay" }));
    ws.sendBinary(new Uint8Array(Bun.concatArrayBuffers(parts)));
  }

  attach(ws: ServerWebSocket<PtySocketData>) {
    if (this.exited !== null) {
      // The shell ended while detached: replay what it printed last, then the exit notice.
      if (this.grace) clearTimeout(this.grace);
      this.sendReplay(ws);
      this.finish(ws);
      return;
    }
    if (this.ws && this.ws !== ws) this.ws.close(4000, "replaced");
    this.ws = ws;
    this.lagging = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.sendReplay(ws);
    // A real size change already makes the program repaint: a nudge on top only flickers.
    const sameSize = ws.data.cols === this.size.cols && ws.data.rows === this.size.rows;
    this.resize(ws.data.cols, ws.data.rows);
    if (sameSize) this.requestRepaint();
  }

  detach(ws: ServerWebSocket<PtySocketData>) {
    if (this.ws === ws) this.ws = null;
  }

  write(data: string | Uint8Array) {
    if (this.exited !== null) return;
    try {
      this.term.write(data);
    } catch {} // the PTY closed (see resizePty)
  }

  resize(cols: number, rows: number) {
    if (!(cols > 0 && rows > 0) || this.exited !== null) return;
    this.size = { cols, rows };
    // During a repaint nudge the end of the nudge applies the latest size: resizing now would
    // undo the size change before the program sees it (the page sends its size right after connecting).
    if (!this.nudge) this.resizePty(cols, rows);
  }

  /**
   * kill() closes the PTY at once, and the shell can take up to 1.5 s to die: until then `exited`
   * is still null and a resize throws. A throw in a WebSocket handler or timer exits the server.
   */
  private resizePty(cols: number, rows: number) {
    if (this.exited !== null) return;
    try {
      this.term.resize(cols, rows);
    } catch {}
  }

  kill() {
    this.endNudge();
    if (this.grace) {
      clearTimeout(this.grace);
      this.onGone(this.id);
      return;
    }
    try {
      // Closing the PTY hangs up the whole session (every job, not just the shell).
      this.term.close();
      this.proc.kill("SIGHUP");
    } catch {}
    setTimeout(() => {
      if (this.exited === null) this.proc.kill("SIGKILL");
    }, 1500);
  }
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();

  constructor(private opts: PtyOptions) {}

  open(ws: ServerWebSocket<PtySocketData>) {
    const { id, cols, rows } = ws.data;
    let s = this.sessions.get(id);
    if (!s) {
      // A shell that cannot start (deleted folder, bad --shell, out of fds or processes) is this
      // terminal's failure, not the server's: a throw from a socket handler exits the process.
      try {
        if (this.sessions.size >= MAX_SESSIONS) throw new Error("too many terminals");
        s = new PtySession(id, this.opts, cols, rows, (gone) => this.sessions.delete(gone));
      } catch {
        ws.send(JSON.stringify({ t: "exit", code: -1 }));
        ws.close(1011, "could not start a shell");
        return;
      }
      this.sessions.set(id, s);
    }
    s.attach(ws);
  }

  message(ws: ServerWebSocket<PtySocketData>, msg: string | Buffer) {
    const s = this.sessions.get(ws.data.id);
    if (!s) return;
    if (typeof msg !== "string") return s.write(new Uint8Array(msg));
    let ctl: { t: string; cols?: number; rows?: number };
    try {
      ctl = JSON.parse(msg);
    } catch {
      return;
    }
    // `null`, `1`, `"x"` parse fine: reading `.t` off null would throw, and a throw here exits the server.
    if (!ctl || typeof ctl !== "object") return;
    if (ctl.t === "resize" && ctl.cols && ctl.rows) {
      ws.data.cols = Math.min(1000, Math.max(2, ctl.cols | 0));
      ws.data.rows = Math.min(500, Math.max(1, ctl.rows | 0));
      s.resize(ws.data.cols, ws.data.rows);
    } else if (ctl.t === "kill") {
      s.kill();
    }
  }

  drain(ws: ServerWebSocket<PtySocketData>) {
    this.sessions.get(ws.data.id)?.drained();
  }

  close(ws: ServerWebSocket<PtySocketData>) {
    this.sessions.get(ws.data.id)?.detach(ws);
  }

  killAll() {
    for (const s of this.sessions.values()) s.kill();
  }
}
