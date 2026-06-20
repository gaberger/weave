// Runtime: Bun only. Uses Bun's built-in SQLite (no native addon), so it compiles into a
// `bun build --compile` binary cleanly — the native-free path from ADR-0010 §4.
import { Database } from "bun:sqlite";

import type { Substrate, Subscription } from "../../ports/substrate.js";
import type { DraftEvent, SealedEvent, Offset } from "../../domain/event.js";
import type { Clock } from "../../domain/clock.js";

interface Row {
  seq: number;
  id: string;
  kind: string;
  actor: string;
  subject: string;
  caused_by: string | null;
  payload: string | null;
  ts: number;
}

interface Subscriber {
  handler: (e: SealedEvent) => void;
  lastSeq: number;
}

export interface BunSqliteSubstrateOptions {
  readonly filename: string;
  readonly clock: Clock;
  readonly pollMs?: number;
}

/** Durable, multi-process Substrate over `bun:sqlite` — the Bun counterpart of
 *  SqliteSubstrate. Identical contract (C1–C5); WAL for concurrency; poll-based subscribe. */
export class BunSqliteSubstrate implements Substrate {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly pollMs: number;
  private readonly subscribers = new Set<Subscriber>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: BunSqliteSubstrateOptions) {
    this.db = new Database(opts.filename);
    // busy_timeout before any write so contended operations wait rather than failing.
    this.db.exec("PRAGMA busy_timeout = 5000");
    // WAL is persistent in the file header; tolerate a lost cold-start switch race between
    // peers (the loser just sees the winner's WAL). Other lock waits use busy_timeout.
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch (e) {
      if (!/lock|busy/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        id       TEXT NOT NULL UNIQUE,
        kind     TEXT NOT NULL,
        actor    TEXT NOT NULL,
        subject  TEXT NOT NULL,
        caused_by TEXT,
        payload  TEXT,
        ts       INTEGER NOT NULL
      )`,
    );
    this.clock = opts.clock;
    this.pollMs = opts.pollMs ?? 50;
  }

  async append(event: DraftEvent): Promise<SealedEvent> {
    this.db
      .query(
        `INSERT OR IGNORE INTO events (id, kind, actor, subject, caused_by, payload, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.kind,
        event.actor,
        event.subject,
        event.causedBy ?? null,
        JSON.stringify(event.payload ?? null),
        this.clock.now(),
      );
    const row = this.db.query(`SELECT * FROM events WHERE id = ?`).get(event.id) as Row;
    return this.toEvent(row);
  }

  async *read(from: Offset): AsyncIterable<SealedEvent> {
    const rows = this.db.query(`SELECT * FROM events WHERE seq >= ? ORDER BY seq`).all(from) as Row[];
    for (const row of rows) yield this.toEvent(row);
  }

  subscribe(from: Offset, handler: (e: SealedEvent) => void): Subscription {
    const sub: Subscriber = { handler, lastSeq: from - 1 };
    const rows = this.db.query(`SELECT * FROM events WHERE seq >= ? ORDER BY seq`).all(from) as Row[];
    for (const row of rows) {
      handler(this.toEvent(row));
      sub.lastSeq = row.seq;
    }
    this.subscribers.add(sub);
    this.ensureTimer();
    return {
      unsubscribe: () => {
        this.subscribers.delete(sub);
        this.maybeStopTimer();
      },
    };
  }

  poll(): void {
    for (const sub of [...this.subscribers]) {
      const rows = this.db
        .query(`SELECT * FROM events WHERE seq >= ? ORDER BY seq`)
        .all(sub.lastSeq + 1) as Row[];
      for (const row of rows) {
        sub.handler(this.toEvent(row));
        sub.lastSeq = row.seq;
      }
    }
  }

  async head(): Promise<Offset> {
    const { m } = this.db.query(`SELECT MAX(seq) AS m FROM events`).get() as { m: number | null };
    return m ?? 0;
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.db.close();
  }

  private ensureTimer(): void {
    if (this.timer === undefined && this.pollMs > 0 && this.subscribers.size > 0) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      if (typeof this.timer.unref === "function") this.timer.unref();
    }
  }

  private maybeStopTimer(): void {
    if (this.subscribers.size === 0 && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private toEvent(row: Row): SealedEvent {
    const base = {
      id: row.id,
      kind: row.kind,
      actor: row.actor,
      subject: row.subject,
      payload: JSON.parse(row.payload ?? "null") as unknown,
      seq: row.seq,
      ts: row.ts,
    };
    return row.caused_by !== null ? { ...base, causedBy: row.caused_by } : base;
  }
}
