import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";
import { log } from "../lib/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own documented pattern for augmenting its Request type via declaration merging; there is no ES module equivalent for extending a third-party ambient namespace.
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

type LogLevel = "info" | "warn" | "error";

function levelForStatus(status: number): LogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

/**
 * Extracts the full request path with any query string stripped (#535).
 * Prefers `req.originalUrl` so mounted sub-routers do not truncate the path,
 * falling back to `req.url` or `req.path`.
 */
export function getRequestPath(req: Request): string {
  const raw = req.originalUrl || req.url || req.path || "";
  const queryIndex = raw.indexOf("?");
  return queryIndex === -1 ? raw : raw.slice(0, queryIndex);
}

/**
 * Structured (JSON) request logging middleware.
 *
 * - Attaches a `requestId` to every request — honouring an inbound
 *   `X-Request-Id` so upstream proxies can correlate, otherwise generating a
 *   fresh UUID — and echoes it back via the `X-Request-Id` response header.
 * - Emits exactly one structured log line per request containing method,
 *   path, status, duration and request id.
 * - Never logs request bodies, headers, query strings, cookies or auth
 *   material, so secrets and PII cannot leak into the logs. Only the safe
 *   path (no query string) and method are recorded.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  req.requestId = (req.header("x-request-id") || randomUUID()).slice(0, 64);

  res.setHeader("X-Request-Id", req.requestId);

  // Capture the full request path at middleware entry before mounted routers
  // rewrite req.url / req.path to router-relative sub-paths (#535).
  const path = getRequestPath(req);
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    log(levelForStatus(res.statusCode), "request completed", {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    });
  });

  next();
}