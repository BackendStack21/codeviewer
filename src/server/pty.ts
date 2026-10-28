import type { ServerWebSocket } from "bun";

/** Output kept per session so a reloaded page can repaint the screen. */
const REPLAY_BYTES = 512 * 1024;
/** Output is coalesced into one WebSocket frame per FLUSH_MS (or per FLUSH_BYTES). */
const FLUSH_MS = 4;
const FLUSH_BYTES = 64 * 1024;
/** Above this much unsent data the client is lagging: stop streaming, resync on drain. */
const HIGH_WATER = 8 * 1024 * 1024;

/** Private modes that change how input/output must be interpreted; restored on replay. */
const TRACKED = [1, 25, 1000, 1002, 1003, 1004, 1006, 2004, 47, 1047, 1049];
const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g;

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
  private modes = new Map<number, boolean>();
  private modesStr = "";
  private carry = "";
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lagging = false;
  ws: ServerWebSocket<PtySocketData> | null = null;
  exited: number | null = null;

  constructor(
    readonly id: string,
    opts: PtyOptions,
    cols: number,
    rows: number,
    private onGone: (id: string) => void,
  ) {
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
      this.flush(); // deliver the last output before the exit notice
      this.ws?.send(JSON.stringify({ t: "exit", code }));
      this.ws?.close(1000, "exited");
      this.onGone(this.id);
    });
  }

  private output(data: Uint8Array) {
    const copy = data.slice();
    this.chunks.push({ data: copy, modes: this.modesStr });
    this.bytes += copy.length;
    while (this.bytes > REPLAY_BYTES && this.chunks.length > 1) this.bytes -= this.chunks.shift()!.data.length;
    this.trackModes(copy);
    if (!this.ws || this.lagging) return;
    this.pending.push(copy);
    this.pendingBytes += copy.length;
    if (this.pendingBytes >= FLUSH_BYTES) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Remembers DECSET/DECRST of tracked modes (sequences may straddle chunks). */
  private trackModes(data: Uint8Array) {
    const text = this.carry + new TextDecoder("latin1").decode(data);
    this.carry = text.slice(-24);
    let changed = false;
    MODE_RE.lastIndex = 0;
    for (let m; (m = MODE_RE.exec(text)); ) {
      for (const n of m[1]!.split(";").map(Number)) {
        if (!TRACKED.includes(n)) continue;
        const on = m[2] === "h";
        if (n === 47 || n === 1047 || n === 1049) {
          this.modes.delete(47);
          this.modes.delete(1047);
          this.modes.delete(1049);
        }
        if (this.modes.get(n) !== on) changed = true;
        this.modes.set(n, on);
      }
    }
    if (changed) {
      let str = "";
      for (const [n, on] of this.modes) if (on) str += `\x1b[?${n}h`;
      this.modesStr = str;
    }
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
  }

  /** Mode prefix + the retained tail, starting at a line boundary when history was trimmed. */
  private sendReplay(ws: ServerWebSocket<PtySocketData>) {
    if (!this.chunks.length) return;
    const first = this.chunks[0]!;
    let head = first.data;
    if (this.bytes >= REPLAY_BYTES - 64 * 1024) {
      // History was trimmed: the first chunk may start mid-escape or mid-UTF-8.
      const nl = head.indexOf(0x0a);
      if (nl >= 0) head = head.subarray(nl + 1);
    }
    const parts = [new TextEncoder().encode(first.modes), head, ...this.chunks.slice(1).map((c) => c.data)];
    ws.send(JSON.stringify({ t: "replay" }));
    ws.sendBinary(new Uint8Array(Bun.concatArrayBuffers(parts)));
  }

  attach(ws: ServerWebSocket<PtySocketData>) {
    if (this.ws && this.ws !== ws) this.ws.close(4000, "replaced");
    this.ws = ws;
    this.lagging = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.sendReplay(ws);
    this.resize(ws.data.cols, ws.data.rows);
  }

  detach(ws: ServerWebSocket<PtySocketData>) {
    if (this.ws === ws) this.ws = null;
  }

  write(data: string | Uint8Array) {
    if (this.exited === null) this.term.write(data);
  }

  resize(cols: number, rows: number) {
    if (cols > 0 && rows > 0 && this.exited === null) this.term.resize(cols, rows);
  }

  kill() {
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
      s = new PtySession(id, this.opts, cols, rows, (gone) => this.sessions.delete(gone));
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
