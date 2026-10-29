import { Router, Request, Response } from "express";
import { RecordedGenerationsQuerySchema } from "../schemas.js";
import { decodeCursor } from "../lib/sequence-feed-query.js";
import { readRecordedGenerations } from "../lib/recorded-generations-query.js";

const router = Router();

const DEFAULT_LIMIT = 50;
// Same settle as GET /internal/sequences: a row is stamped at insert START.
const SETTLE_SECONDS = 60;

/**
 * GET /internal/generations/recorded (FACTORY-P3-RECORD-SYSTEM-PROMPT)
 *
 * API key only (mounted after apiKeyAuth), every org. Each email generation that recorded its
 * chat-service request, with that request, its inputs, the answer and the stored output. Read by
 * workflow-service's case recorder. Carries personal data: nothing of it is ever logged here.
 */
router.get("/internal/generations/recorded", async (req: Request, res: Response) => {
  const parsed = RecordedGenerationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") });
  }
  const { from, to, runId, cursor: rawCursor, limit } = parsed.data;
  if (from === undefined && runId === undefined) {
    return res.status(400).json({ error: "from or runId is required" });
  }
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    return res.status(400).json({ error: "cursor is not a cursor issued by this service" });
  }
  try {
    const page = await readRecordedGenerations({
      from,
      to,
      runId,
      cursor,
      limit: limit ?? DEFAULT_LIMIT,
      settleSeconds: SETTLE_SECONDS,
    });
    res.json(page);
  } catch (error) {
    console.error(`[content-gen] GET /internal/generations/recorded failed: ${(error as Error).message}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
