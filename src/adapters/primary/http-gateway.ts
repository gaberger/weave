import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/** One inbound HTTP request the gateway turns into a task declaration. */
export interface GatewayEvent {
  readonly method: string;
  readonly path: string;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly body: string;
}

/** Config for the inbound event gateway (ADR-0023). `onEvent` is INJECTED so this adapter imports no
 *  use-case/substrate — composition wires `declareTask` in (strict hex, ADR-0015). */
export interface HttpGatewayConfig {
  readonly port: number;
  /** Bind address. Defaults to loopback so the listener isn't world-reachable unless asked. */
  readonly host?: string;
  /** Path that declares a task on POST (e.g. "/hook"). Other paths 404; GET it (or /health) = health. */
  readonly route: string;
  /** Shared secret required in the `X-Weave-Secret` header to declare. Omit = no auth (loopback only). */
  readonly secret?: string;
  /** Max request body bytes (default 1 MiB) — a runaway/abusive POST can't exhaust memory. */
  readonly maxBytes?: number;
  /** Turn a validated inbound event into a declared task; returns the new task id (or throws). */
  readonly onEvent: (e: GatewayEvent) => Promise<{ taskId: string }>;
  readonly log?: (msg: string) => void;
}

export interface HttpGatewayHandle {
  /** The actual bound port (useful when config.port is 0 = ephemeral, e.g. in tests). */
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_MAX_BYTES = 1 << 20; // 1 MiB

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
  res.end(text);
}

/** Read the request body with a hard byte cap; rejects (destroys the socket) if exceeded. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Start the inbound event gateway (ADR-0023). Resolves once listening. A POST to `route` (with the
 * shared secret, if configured) is handed to `onEvent`, which declares a task; the response is
 * `202 { taskId }`. A GET to `route` or `/health` is a health check. Everything else is 404. The
 * gateway declares work but wields no execution authority — declared tasks still run under a peer's
 * grant ceiling (ADR-0004).
 */
export function startHttpGateway(cfg: HttpGatewayConfig): Promise<HttpGatewayHandle> {
  const maxBytes = cfg.maxBytes ?? DEFAULT_MAX_BYTES;
  const host = cfg.host ?? "127.0.0.1";

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      const method = (req.method ?? "GET").toUpperCase();

      // Health: GET the route or /health. Never declares.
      if (method === "GET" && (path === cfg.route || path === "/health")) {
        return send(res, 200, "ok");
      }
      if (path !== cfg.route) return send(res, 404, "not found");
      if (method !== "POST") return send(res, 405, "method not allowed");

      // Auth: a configured secret must match the X-Weave-Secret header. Without a secret, rely on the
      // loopback bind (the default) — declaring is still gated by the peers' grant ceiling downstream.
      if (cfg.secret) {
        const got = req.headers["x-weave-secret"];
        if (got !== cfg.secret) {
          cfg.log?.("gateway: rejected POST — bad/missing X-Weave-Secret");
          return send(res, 401, "unauthorized");
        }
      }

      let body: string;
      try {
        body = await readBody(req, maxBytes);
      } catch (e) {
        return send(res, 413, e instanceof Error ? e.message : "bad body");
      }

      try {
        const { taskId } = await cfg.onEvent({ method, path, headers: req.headers, body });
        cfg.log?.(`gateway: declared ${taskId} from ${method} ${path}`);
        return send(res, 202, { taskId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        cfg.log?.(`gateway: event rejected — ${msg}`);
        return send(res, 400, { error: msg });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, host, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : cfg.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections?.(); // don't let keep-alive sockets stall shutdown (Node 18.2+)
            server.close(() => res());
          }),
      });
    });
  });
}
