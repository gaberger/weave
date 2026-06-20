import type { SealedEvent } from "./event.js";
import { TaskKind } from "./task.js";
import type { ProbeFinding } from "./interrogation.js";

/** The event kind for a compaction snapshot (condensation-as-an-event, ADR-0007 §1). */
export const SNAPSHOT_KIND = "weave.snapshot";

export interface SnapshotPayload {
  /** Events with seq <= upTo are folded into this snapshot. */
  readonly upTo: number;
  /** Subjects known to be terminal (completed/failed). */
  readonly settled: readonly string[];
  /** Latest interrogation finding per target (bounded: one per target). */
  readonly findings: Readonly<Record<string, ProbeFinding>>;
}

/** Subjects known-settled = terminal events + any prior snapshot's settled set. */
export function settledSubjects(events: readonly SealedEvent[]): Set<string> {
  const set = new Set<string>();
  for (const e of events) {
    if (e.kind === TaskKind.Completed || e.kind === TaskKind.Failed) {
      set.add(e.subject);
    } else if (e.kind === SNAPSHOT_KIND) {
      for (const s of (e.payload as SnapshotPayload).settled) set.add(s);
    }
  }
  return set;
}

export interface Compaction {
  readonly payload: SnapshotPayload;
  /** Subjects to retain (not yet settled) — their events must NOT be pruned. */
  readonly activeSubjects: Set<string>;
}

interface ArtifactRef {
  kind: string;
  ref: string;
}

/** Fold the log: compute settled subjects, latest finding per target (carried forward from
 *  prior snapshots), the active subject set, and the high-water seq. Pure. (ADR-0007 §1/§3) */
export function compact(events: readonly SealedEvent[]): Compaction {
  const settled = settledSubjects(events);
  const declared = new Set<string>();
  const findings: Record<string, ProbeFinding> = {};
  let upTo = 0;

  for (const e of events) {
    upTo = Math.max(upTo, e.seq);
    if (e.kind === SNAPSHOT_KIND) {
      Object.assign(findings, (e.payload as SnapshotPayload).findings);
    } else if (e.kind === TaskKind.Declared) {
      declared.add(e.subject);
    } else if (e.kind === TaskKind.Completed) {
      const arts = (e.payload as { artifacts?: ArtifactRef[] }).artifacts ?? [];
      for (const a of arts) {
        if (a.kind !== "probe") continue;
        try {
          const f = JSON.parse(a.ref) as ProbeFinding;
          if (typeof f.target === "string") findings[f.target] = f;
        } catch {
          /* ignore malformed artifact */
        }
      }
    }
  }

  const activeSubjects = new Set<string>();
  for (const s of declared) if (!settled.has(s)) activeSubjects.add(s);

  return { payload: { upTo, settled: [...settled], findings }, activeSubjects };
}
