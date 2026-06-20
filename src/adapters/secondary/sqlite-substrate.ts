import Database from "better-sqlite3";

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

export interface SqliteSubstrateOptions {
  /** DB file path. A file (not :memory:) is what makes this multi-process (ADR-0002 §4). */
  readonly filename: string;
  readonly clock: Clock;
  /** Live-tail poll interval (ms). 0 disables the auto-timer — call `poll()` manually. */
  readonly pollMs?: number;
}

/**
 * Durable, multi-process Substrate over SQLite (ADR-0002 §4, `SqliteSubstrate` row).
 * AUTOINCREMENT gives a strong monotonic total order (C1/C2); WAL lets many processes on
 * one host read while one writes. SQLite has no pub/sub, so `subscribe` is a poll over
 * `seq` — the only behavioural difference from InProcessSubstrate, and invisible to
 * use-cases (the winner check reads the log directly, not the subscription).
 */
export class SqliteSubstrate implements Substrate {
  private readonly db: Database.Database;
  private readonly clock: Clock;
  private readonly pollMs: number;
  private readonly subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | undefined;

  private readonly insertStmt: Database.Statement;
  private readonly byIdStmt: Database.Statement;
  private readonly readStmt: Database.Statement;
  private readonly headStmt: Database.Statement;

  constructor(opts: SqliteSubstrateOptions) {
    this.db = new Database(opts.filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
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

    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO events (id, kind, actor, subject, caused_by, payload, ts)
       VALUES (@id, @kind, @actor, @subject, @caused_by, @payload, @ts)`,
    );
    this.byIdStmt = this.db.prepare(`SELECT * FROM events WHERE id = ?`);
    this.readStmt = this.db.prepare(`SELECT * FROM events WHERE seq >= ? ORDER BY seq`);
    this.headStmt = this.db.prepare(`SELECT MAX(seq) AS m FROM events`);
  }

  async append(event: DraftEvent): Promise<SealedEvent> {
    this.insertStmt.run({
      id: event.id,
      kind: event.kind,
      actor: event.actor,
      subject: event.subject,
      caused_by: event.causedBy ?? null,
      payload: JSON.stringify(event.payload ?? null),
      ts: this.clock.now(),
    });
    // Whether we inserted or the id already existed (C3 idempotent), the row is authoritative.
    const row = this.byIdStmt.get(event.id) as Row;
    return this.toEvent(row);
  }

  async *read(from: Offset): AsyncIterable<SealedEvent> {
    for (const row of this.readStmt.all(from) as Row[]) {
      yield this.toEvent(row);
    }
  }

  subscribe(from: Offset, handler: (e: SealedEvent) => void): Subscription {
    const sub: Subscriber = { handler, lastSeq: from - 1 };
    // Replay history at/after `from` (C4), advancing the cursor.
    for (const row of this.readStmt.all(from) as Row[]) {
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

  /** Deliver any rows newer than each subscriber's cursor. Driven by the timer, or call
   *  directly for deterministic tests. */
  poll(): void {
    for (const sub of [...this.subscribers]) {
      for (const row of this.readStmt.all(sub.lastSeq + 1) as Row[]) {
        sub.handler(this.toEvent(row));
        sub.lastSeq = row.seq;
      }
    }
  }

  async head(): Promise<Offset> {
    const { m } = this.headStmt.get() as { m: number | null };
    return m ?? 0;
  }

  /** Release the DB handle. Not part of the Substrate port; for lifecycle/cleanup. */
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
