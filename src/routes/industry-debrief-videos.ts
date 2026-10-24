import { Router, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { AuthenticatedRequest, serviceAuth, serviceAuthRunOptional } from "../middleware/auth.js";
import { DebriefVideoRequestSchema } from "../schemas.js";
import { extractTracking } from "../lib/tracking.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { enqueueDebrief, toDebriefResponse } from "../lib/debrief/jobs.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { renderShips, DRY_RUN_SUPPORT } from "../lib/debrief/ships.js";

const router = Router();

/** One GET holds at most this long: under the platform's 300 s client timeout. */
export const MAX_WAIT_SECONDS = 240;
const WAIT_POLL_MS = 3000;

// schema.js is replaced wholesale by unit-suite mocks: read the table at request time.
const table = () => schema.industryDebriefVideos;

async function findForOrg(orgId: string, where: { id?: string; idempotencyKey?: string }) {
  const t = table();
  const cond = where.id ? eq(t.id, where.id) : eq(t.idempotencyKey, where.idempotencyKey!);
  const [row] = await db.select().from(t).where(and(eq(t.orgId, orgId), cond));
  return row;
}

router.post(
  "/industry-debrief-videos",
  (req, res, next) => serviceAuth(req as AuthenticatedRequest, res, next),
  async (req: AuthenticatedRequest, res: Response) => {
    const parsed = DebriefVideoRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: JSON.stringify(parsed.error.flatten()) });
    const body = parsed.data;
    const orgId = req.orgId!;

    if (body.idempotencyKey) {
      const existing = await findForOrg(orgId, { idempotencyKey: body.idempotencyKey });
      if (existing) return res.status(202).json(toDebriefResponse(existing));
    }

    const tracking = extractTracking(req);
    // A dry run (or a render with no campaign) is a staff test: its run opens marked support and
    // never declares industry_update_video (DRY-RUN-RENDER-1024).
    const ships = renderShips({ dryRun: body.dryRun, campaignId: tracking.campaignId });
    const run = await createRun({
      serviceName: "content-generation-service",
      taskName: "industry-debrief-video",
      brandId: tracking.brandId,
      campaignId: tracking.campaignId,
      workflowSlug: tracking.workflowSlug,
      ...(ships ? {} : { support: DRY_RUN_SUPPORT }),
    }, tracking);

    try {
      const [row] = await db.insert(table()).values({
        orgId,
        userId: req.userId!,
        parentRunId: req.runId!,
        runId: run.id,
        tracking: {
          campaignId: tracking.campaignId, brandId: tracking.brandId, workflowSlug: tracking.workflowSlug,
          featureSlug: tracking.featureSlug, audienceId: tracking.audienceId,
        },
        idempotencyKey: body.idempotencyKey ?? null,
        request: body,
      }).returning();
      enqueueDebrief(row.id);
      return res.status(202).json(toDebriefResponse(row));
    } catch (err) {
      if (isUniqueViolation(err, "idx_debrief_videos_idempotency")) {
        // A concurrent POST with the same key won: answer its render, close the run we opened for nothing.
        await updateRun(run.id, "failed", { ...tracking, runId: run.id }).catch(() => {});
        const winner = await findForOrg(orgId, { idempotencyKey: body.idempotencyKey });
        if (winner) return res.status(202).json(toDebriefResponse(winner));
      }
      throw err;
    }
  },
);

router.get(
  "/industry-debrief-videos/:id",
  (req, res, next) => serviceAuthRunOptional(req as AuthenticatedRequest, res, next),
  async (req: AuthenticatedRequest, res: Response) => {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: "Not found" });
    let waitSeconds = 0;
    if (req.query.waitSeconds !== undefined) {
      waitSeconds = Number(req.query.waitSeconds);
      if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) {
        return res.status(400).json({ error: `waitSeconds must be an integer from 0 to ${MAX_WAIT_SECONDS}` });
      }
    }
    const deadline = Date.now() + waitSeconds * 1000;
    let gone = false;
    req.on("close", () => { gone = true; });
    let row = await findForOrg(req.orgId!, { id });
    if (!row) return res.status(404).json({ error: "Not found" });
    while ((row.status === "queued" || row.status === "rendering") && Date.now() < deadline && !gone) {
      await new Promise((r) => setTimeout(r, Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now()))));
      row = (await findForOrg(req.orgId!, { id }))!;
    }
    if (gone) return;
    return res.status(200).json(toDebriefResponse(row));
  },
);

export default router;
