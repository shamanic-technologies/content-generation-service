/**
 * What the reels routes share (REELS-1124): the error → HTTP answer mapping, the `waitSeconds`
 * hold, the identity an LLM / transcription call is made under (the CALLER's, as received).
 */
import type { Response } from "express";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import { ChatModelCatalogueError, UnknownModelError } from "../chat-model-catalogue.js";
import { extractTracking, type Tracking } from "../tracking.js";
import { ReelsError } from "./errors.js";
import { ReelsInsufficientCreditsError } from "./llm.js";

/** One GET holds at most this long: under the platform's 300 s client timeout. */
export const MAX_WAIT_SECONDS = 240;
export const WAIT_POLL_MS = 2000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sendReelsError(res: Response, err: unknown, what: string, fallbackStatus = 500): Response {
  if (err instanceof ReelsError) return res.status(err.httpStatus).json({ error: err.message, code: err.code });
  if (err instanceof UnknownModelError) return res.status(400).json({ error: err.message, code: err.code, accepted: err.accepted });
  if (err instanceof ChatModelCatalogueError) return res.status(502).json({ error: err.message, code: err.code });
  if (err instanceof ReelsInsufficientCreditsError) {
    return res.status(402).json({ error: "Insufficient credits", balance_cents: err.balance_cents, required_cents: err.required_cents });
  }
  console.error(`[reels] ${what} failed:`, err);
  return res.status(fallbackStatus).json({ error: err instanceof Error ? err.message : "Internal server error" });
}

export function badRequest(res: Response, issues: Array<{ path: PropertyKey[]; message: string }>): Response {
  return res.status(400).json({ error: issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join(", ") });
}

/** The `waitSeconds` query as a deadline; null = the answer (400) was already sent. */
export function waitDeadline(req: AuthenticatedRequest, res: Response): number | null {
  let waitSeconds = 0;
  if (req.query.waitSeconds !== undefined) {
    waitSeconds = Number(req.query.waitSeconds);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) {
      res.status(400).json({ error: `waitSeconds must be an integer from 0 to ${MAX_WAIT_SECONDS}` });
      return null;
    }
  }
  return Date.now() + waitSeconds * 1000;
}

/** Re-reads `read()` until `inFlight` is false, the deadline passes or the client leaves. undefined = the client left. */
export async function holdWhile<T>(req: AuthenticatedRequest, deadline: number, first: T, read: () => Promise<T | undefined>, inFlight: (row: T) => boolean): Promise<T | undefined> {
  let gone = false;
  req.on("close", () => { gone = true; });
  let row = first;
  while (inFlight(row) && Date.now() < deadline && !gone) {
    await new Promise((r) => setTimeout(r, Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now()))));
    row = (await read()) ?? row;
  }
  return gone && inFlight(row) ? undefined : row;
}

/** The caller's identity, forwarded as received to chat-service (its run carries the cost). */
export function callerIdentity(req: AuthenticatedRequest): Tracking & { runId: string } {
  return { ...extractTracking(req), runId: req.runId! };
}

/** What a row keeps of the caller's attribution. */
export function trackingOf(req: AuthenticatedRequest) {
  const t = extractTracking(req);
  return { campaignId: t.campaignId, brandId: t.brandId, workflowSlug: t.workflowSlug, featureSlug: t.featureSlug, audienceId: t.audienceId };
}

/** Exactly one way to decide: the name of the one sent, or the 400 to answer. */
export function exactlyOne(ways: Record<string, unknown>): { way: string } | { status: 400; code: "MODEL_WITH_COMPLETION" | "MODEL_REQUIRED"; error: string } {
  const sent = Object.entries(ways).filter(([, v]) => v !== undefined && v !== null).map(([k]) => k);
  const names = Object.keys(ways).map((k) => `\`${k}\``).join(", ");
  if (sent.length > 1) return { status: 400, code: "MODEL_WITH_COMPLETION", error: `Send exactly one of ${names} (got ${sent.join(" and ")})` };
  if (sent.length === 0) return { status: 400, code: "MODEL_REQUIRED", error: `Send one of ${names}` };
  return { way: sent[0] };
}
