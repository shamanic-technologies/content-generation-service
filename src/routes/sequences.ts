import { Router, Request, Response } from "express";
import { SequenceFeedQuerySchema } from "../schemas.js";
import { decodeCursor, readSequenceFeed } from "../lib/sequence-feed-query.js";

const router = Router();

const DEFAULT_LIMIT = 500;
// A row is served once it is this old: see the settle note in sequence-feed-query.ts.
const SETTLE_SECONDS = 60;

/**
 * GET /internal/sequences
 *
 * Fleet-wide, API-key-only feed of generated sequences (every org): what wrote each one
 * (concrete model, template version, workflow version, run) and three deterministic classes
 * of its first email's text. Followed incrementally with `nextCursor`.
 */
router.get("/internal/sequences", async (req: Request, res: Response) => {
  const parsed = SequenceFeedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.message });
  }
  const { featureSlug, cursor: rawCursor, limit } = parsed.data;

  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    return res.status(400).json({ error: "cursor is not a cursor issued by GET /internal/sequences" });
  }

  const page = await readSequenceFeed({
    featureSlug,
    cursor,
    limit: limit ?? DEFAULT_LIMIT,
    settleSeconds: SETTLE_SECONDS,
  });
  res.json(page);
});

export default router;
