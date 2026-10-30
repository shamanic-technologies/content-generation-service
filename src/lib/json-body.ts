import express from "express";

/**
 * Inbound JSON ceilings (EMAIL-413-1030).
 *
 * Every route keeps express's own default, 100kb, made explicit: the bound is
 * part of the OOM defence (see CLAUDE.md "Response-size bounds").
 *
 * The two email-writer doors carry more by contract and get their own ceiling.
 * `POST /generate` with `written` + `units` (FACTORY-P3 script writer) carries
 * the script's whole traced answer (the exact chat-service request, system
 * prompt with the brand context included, and chat's whole answer) PLUS the
 * materials it was handed PLUS the request's `variables`. A brand with a long
 * description crossed 100kb on every lead (Doc Dinners, 2026-10-29: ~148 KB,
 * every run of its main campaign 413'd). The size is the brand's context, not
 * a bad caller, and none of it may be cut: the stored row must be the email the
 * script wrote. 1mb is ~7x the largest seen, still a bounded parse.
 */
export const JSON_BODY_LIMIT = "100kb";
export const WRITER_JSON_BODY_LIMIT = "1mb";
export const WRITER_ROUTES = ["/generate", "/generate/materials"] as const;

/** Mounts the writer doors' parser first (exact paths, POST), then the default. */
export function mountJsonBodyParsers(app: express.Express): void {
  const writerParser = express.json({ limit: WRITER_JSON_BODY_LIMIT });
  for (const path of WRITER_ROUTES) app.post(path, writerParser);
  // body-parser skips a request an earlier parser already read (req._body).
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
}

/** The ceiling that refused this request, as configured ("100kb" | "1mb"). */
export function jsonBodyLimitFor(method: string, path: string): string {
  return method === "POST" && (WRITER_ROUTES as readonly string[]).includes(path)
    ? WRITER_JSON_BODY_LIMIT
    : JSON_BODY_LIMIT;
}

/**
 * body-parser rejects an oversized body with type `entity.too.large`. Surface it
 * as the 413 it is so the caller reads a real limit instead of an opaque 500.
 * Returns false when the error is something else.
 */
export function respondIfBodyTooLarge(err: unknown, req: express.Request, res: express.Response): boolean {
  if ((err as { type?: string } | null)?.type !== "entity.too.large") return false;
  const limit = jsonBodyLimitFor(req.method, req.path);
  console.error(
    `[content-generation-service] Request body over the ${limit} limit: ${req.method} ${req.path}`
  );
  res.status(413).json({ error: `Request body exceeds the ${limit} limit`, limit });
  return true;
}
