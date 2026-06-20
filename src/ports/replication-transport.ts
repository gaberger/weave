import type { SealedEvent } from "../domain/event.js";

/** Wire seam for NetworkedSubstrate (ADR-0009 §4). The substrate gossips local appends
 *  via `broadcast` and applies peers' events via the `onReceive` handler. Real adapters
 *  (WebSocket/libp2p) implement this; tests use a partitionable in-memory hub. The
 *  transport is responsible for fan-out and at-least-once delivery / anti-entropy; the
 *  substrate handles dedup-by-id, so duplicate deliveries are safe. */
export interface ReplicationTransport {
  broadcast(event: SealedEvent): void;
  onReceive(handler: (event: SealedEvent) => void): void;
}
