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
const LATIN1 = new TextDecoder("latin1");
/**
 * DECSET/DECRST: 7-bit CSI, or C1 CSI as UTF-8 (C2 9B: the terminal decodes UTF-8 first, so a bare 9B byte is a continuation byte, not CSI); `;` or `:` separated.
 * The text is decoded as "latin1", which WHATWG maps to windows-1252: byte 9B reads as U+203A.
 */
const MODE_RE = /(?:\x1b\[|\xc2\u203a)\?([\d;:]+)([hl])/g;
/** An unfinished sequence carried into the next chunk is at most this long (one with many modes is fine). */
const MAX_CARRY = 256;

/** Applies every tracked DECSET/DECRST in `text` to `modes`; true when something changed. */
export function applyModes(modes: Map<number, boolean>, text: string): boolean {
  let changed = false;
  MODE_RE.lastIndex = 0;
  for (let m; (m = MODE_RE.exec(text)); ) {
    for (const part of m[1]!.split(";")) {
      const n = Number(part.split(":")[0]);
      if (!TRACKED.includes(n)) continue;
      const on = m[2] === "h";
      if (n === 47 || n === 1047 || n === 1049) {
        for (const k of [47, 1047, 1049]) if (k !== n && modes.delete(k)) changed = true;
      }
      if (modes.get(n) !== on) changed = true;
      modes.set(n, on);
    }
  }
  return changed;
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
  private chunks: { data: Uint8Array; modes: string }[] = [];
  private bytes = 0;
  /** The ring has dropped output, so a replay no longer holds everything since the session began. */
  private ringTrimmed = false;
  private size: { cols: number; rows: number };
  private nudge: ReturnType<typeof setTimeout> | null = null;
  private modes = new Map<number, boolean>();
  private modesStr = "";
  private carry = "";
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
    this.chunks.push({ data: copy, modes: this.modesStr });
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
    const text = this.carry + LATIN1.decode(data);
    const esc = Math.max(text.lastIndexOf("\x1b"), text.lastIndexOf("\xc2"));
    this.carry = esc >= 0 && text.length - esc <= MAX_CARRY ? text.slice(esc) : "";
    if (applyModes(this.modes, text)) this.modesStr = modesPrefix(this.modes);
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
    let prefix = first.modes;
    if (this.ringTrimmed) {
      // History was trimmed: the first chunk may start mid-escape or mid-UTF-8.
      const nl = head.indexOf(0x0a);
      if (nl >= 0) {
        // The skipped bytes may change modes (a TUI exiting): the prefix must include them.
        const modes = new Map<number, boolean>();
        applyModes(modes, first.modes);
        if (applyModes(modes, LATIN1.decode(head.subarray(0, nl + 1)))) prefix = modesPrefix(modes);
        head = head.subarray(nl + 1);
      }
    }
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
