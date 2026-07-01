import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SealedEvent } from "../../domain/event.js";
import type { Subscription } from "../../ports/substrate.js";

/**
 * Outbound event surface (ADR-0025) — the mirror of the inbound gateway (ADR-0023).
 *
 * Where the gateway turns an inbound POST into a task declaration, this turns the substrate's
 * `subscribe()` stream into a live outbound push over Server-Sent Events, and serves the static
 * blackboard page that consumes it. It is READ-ONLY: it pushes events, declares nothing, and holds
 * no execution authority.
 *
 * `subscribe`/`filter`/`page` are INJECTED so this adapter imports no substrate/use-case — only the
 * domain `SealedEvent` and the `Subscription` port type (strict hex, ADR-0015). Composition (cli.ts)
 * wires the real `weave.subscribe` and the terminal's log filter in.
 */
export interface SseSurfaceConfig {
  readonly port: number;
  /** Bind address. Defaults to loopback so the surface isn't world-reachable unless asked. */
  readonly host?: string;
  /** Shared secret required to open the stream. Browsers' EventSource can't set headers, so it is
   *  checked against the `?secret=` query param (or the `X-Weave-Secret` header for non-browser
   *  clients). Omit = no auth (rely on the loopback bind). */
  readonly secret?: string;
  /** Subscribe from an offset; every event is pushed to connected clients. `Subscription.unsubscribe`
   *  is called when the client disconnects. */
  readonly subscribe: (from: number, handler: (e: SealedEvent) => void) => Subscription;
  /** Only events passing this predicate are pushed (reuse the terminal's keepLog). Default: all. */
  readonly filter?: (e: SealedEvent) => boolean;
  /** The blackboard HTML served at `GET /`. */
  readonly page: string;
  /** The inbound gateway's port + route, exposed at `GET /config` so the blackboard can build the
   *  gateway URL from its own hostname and POST voice-declared tasks there (the write path stays on
   *  the gateway; this surface stays read-only). Omit to disable voice input in the page. */
  readonly gateway?: { readonly port: number; readonly route: string };
  /** Comment-ping interval to keep proxies/browsers from idling the connection out (default 15s). */
  readonly heartbeatMs?: number;
  readonly log?: (msg: string) => void;
}

export interface SseSurfaceHandle {
  /** The actual bound port (useful when config.port is 0 = ephemeral, e.g. in tests). */
  readonly port: number;
  /** Number of currently-connected stream clients. */
  clients(): number;
  close(): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

/** Parse `from` for a (re)connecting client: EventSource resends the last id it saw via the
 *  `Last-Event-ID` header; a fresh client may pass `?from=<seq>`. Missing/invalid → live-tail only
 *  (undefined, resolved to head+1 by the caller's default). */
function parseFrom(req: IncomingMessage, query: URLSearchParams): number | undefined {
  const lastId = req.headers["last-event-id"];
  const raw = (Array.isArray(lastId) ? lastId[0] : lastId) ?? query.get("from") ?? undefined;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  // Last-Event-ID is the last seq DELIVERED; resume strictly after it. A raw ?from is inclusive.
  return req.headers["last-event-id"] !== undefined ? n + 1 : n;
}

/** Serialize one event as an SSE frame. `id:` lets the browser resume via Last-Event-ID on reconnect;
 *  `data:` is the JSON event. A single-line JSON payload needs no multi-line `data:` splitting. */
function frame(e: SealedEvent): string {
  return `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
}

/**
 * Start the outbound SSE surface (ADR-0025). Resolves once listening.
 *
 * Routes (all GET; the surface never mutates):
 *  - `/` or `/index.html` → the blackboard page (text/html).
 *  - `/events`            → the SSE stream. Replays from `Last-Event-ID`/`?from`, then live-tails.
 *  - `/health`            → `ok`.
 *  - anything else        → 404.
 */
export function startSseSurface(cfg: SseSurfaceConfig): Promise<SseSurfaceHandle> {
  const host = cfg.host ?? "127.0.0.1";
  const heartbeatMs = cfg.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const filter = cfg.filter ?? (() => true);
  /** Live stream responses, so shutdown can end them (SSE sockets never close on their own). */
  const open = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;

    if (method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      return void res.end("method not allowed");
    }

    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end("ok");
    }

    // Read-only config for the page: where to POST voice-declared tasks (the gateway). Returns
    // {gateway:null} when no gateway is wired, so the blackboard disables its mic.
    if (path === "/config") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return void res.end(JSON.stringify({ gateway: cfg.gateway ?? null }));
    }

    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(cfg.page);
    }

    if (path === "/events") {
      // Auth: EventSource can't set headers, so accept the secret via query param too.
      if (cfg.secret) {
        const got = url.searchParams.get("secret") ?? req.headers["x-weave-secret"];
        if (got !== cfg.secret) {
          cfg.log?.("surface: rejected stream — bad/missing secret");
          res.writeHead(401, { "content-type": "text/plain" });
          return void res.end("unauthorized");
        }
      }

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // A reverse proxy (nginx) buffers text/event-stream by default; tell it not to.
        "x-accel-buffering": "no",
      });
      res.write("retry: 3000\n\n"); // ask the browser to reconnect ~3s after a drop

      const from = parseFrom(req, url.searchParams);
      const sub: Subscription = cfg.subscribe(from ?? 0, (e) => {
        if (!filter(e)) return;
        // A client can disconnect between events; a write to a dead socket throws. Guard + clean up.
        try {
          res.write(frame(e));
        } catch {
          sub.unsubscribe();
        }
      });

      const hb = setInterval(() => {
        try {
          res.write(`:hb\n\n`); // SSE comment: ignored by the client, resets idle timers
        } catch {
          /* closed; the 'close' handler below tears down */
        }
      }, heartbeatMs);

      open.add(res);
      const cleanup = (): void => {
        clearInterval(hb);
        sub.unsubscribe();
        open.delete(res);
      };
      req.on("close", cleanup);
      res.on("error", cleanup);
      cfg.log?.(`surface: stream opened (${open.size} client${open.size === 1 ? "" : "s"})`);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    return void res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, host, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : cfg.port;
      resolve({
        port,
        clients: () => open.size,
        close: () =>
          new Promise<void>((done) => {
            for (const res of open) {
              try {
                res.end();
              } catch {
                /* already gone */
              }
            }
            open.clear();
            server.closeAllConnections?.(); // don't let keep-alive/SSE sockets stall shutdown (Node 18.2+)
            server.close(() => done());
          }),
      });
    });
  });
}
