import type { Request, Response, NextFunction } from "express";

/**
 * Request logging for OOM forensics.
 *
 * The service has died on `FATAL ERROR: Reached heap limit` with nothing in the
 * logs between boot and the fatal, so the request that took the process down was
 * not identifiable. A fatal OOM gives no chance to log on the way out, so the
 * line that names the culprit has to be written when the request STARTS — the
 * last `[req] ->` line before the fatal is the request that was in flight.
 *
 * Logged: method, path, declared inbound byte count, and identity/attribution
 * headers already used for tracking. Never the body, never query values, never
 * any generated content.
 */
export function requestLog(req: Request, res: Response, next: NextFunction) {
  const started = Date.now();
  const declared = Number(req.headers["content-length"] ?? 0);
  const inBytes = Number.isFinite(declared) ? declared : 0;

  const orgId = (req.headers["x-org-id"] as string | undefined) ?? "-";
  const runId = (req.headers["x-run-id"] as string | undefined) ?? "-";

  console.log(`[req] -> ${req.method} ${req.path} inBytes=${inBytes} org=${orgId} run=${runId}`);

  res.on("finish", () => {
    const outHeader = res.getHeader("content-length");
    const outBytes = typeof outHeader === "string" || typeof outHeader === "number" ? Number(outHeader) : 0;
    console.log(
      `[req] <- ${req.method} ${req.path} ${res.statusCode} ms=${Date.now() - started} ` +
        `inBytes=${inBytes} outBytes=${Number.isFinite(outBytes) ? outBytes : 0} org=${orgId} run=${runId}`
    );
  });

  next();
}
