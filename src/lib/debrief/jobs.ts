/**
 * The render queue behind POST /industry-debrief-videos. Renders run ONE AT A TIME
 * in this process (the box is shared; a render is minutes of CPU), each in its own
 * runs-service run, uploaded to R2 through cloudflare-service, state persisted on
 * `industry_debrief_videos` so a poll survives a restart.
 *
 * Restart: a deploy kills an in-flight render. On boot, a job younger than
 * RESUME_MAX_AGE_MS is rendered again from scratch (the request is stored); an
 * older one is failed RENDER_INTERRUPTED rather than delivered hours late.
 *
 * Schema/db reads stay inside functions: unit suites replace schema.js wholesale.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { db } from "../../db/index.js";
import { industryDebriefVideos, type IndustryDebriefVideo } from "../../db/schema.js";
import type { DebriefVideoRequest } from "../../schemas.js";
import type { Tracking } from "../tracking.js";
import { updateRun } from "../runs-client.js";
import { uploadBase64ToStorage } from "../storage-client.js";
import { DebriefError } from "./errors.js";
import { renderDebriefVideo } from "./pipeline.js";

export const RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const queue: string[] = [];
let draining = false;

export function enqueueDebrief(id: string): void {
  if (!queue.includes(id)) queue.push(id);
  if (!draining) {
    draining = true;
    void drain();
  }
}

async function drain(): Promise<void> {
  try {
    while (queue.length) {
      const id = queue.shift()!;
      await processDebrief(id).catch((err) => console.error(`[debrief] ${id} crashed outside its error handling:`, err));
    }
  } finally {
    draining = false;
  }
}

/** Identity the render acts under: the job's own run, the caller's attribution. */
function identityOf(row: IndustryDebriefVideo): Tracking & { runId: string } {
  const t = row.tracking as Tracking;
  return { ...t, orgId: row.orgId, userId: row.userId, runId: row.runId };
}

/** The last delivered render's track, so consecutive days never share one. */
async function previousTrackId(): Promise<number | null> {
  const [last] = await db
    .select({ musicTrackId: industryDebriefVideos.musicTrackId })
    .from(industryDebriefVideos)
    .where(and(eq(industryDebriefVideos.status, "done"), isNotNull(industryDebriefVideos.musicTrackId)))
    .orderBy(desc(industryDebriefVideos.finishedAt))
    .limit(1);
  return last?.musicTrackId ?? null;
}

export async function processDebrief(id: string): Promise<void> {
  const [row] = await db.select().from(industryDebriefVideos).where(eq(industryDebriefVideos.id, id));
  if (!row || row.status === "done" || row.status === "failed") return;
  const identity = identityOf(row);
  const t0 = Date.now();
  await db.update(industryDebriefVideos)
    .set({ status: "rendering", stage: null, startedAt: new Date() })
    .where(eq(industryDebriefVideos.id, id));
  const setStage = (stage: string) => {
    console.log(`[debrief] ${id} ${stage} (+${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    db.update(industryDebriefVideos).set({ stage }).where(eq(industryDebriefVideos.id, id))
      .catch((err) => console.error(`[debrief] ${id} stage write failed:`, err));
  };

  try {
    const req = row.request as DebriefVideoRequest;
    const rendered = await renderDebriefVideo(req, await previousTrackId(), setStage);
    let url: string;
    try {
      setStage("uploading");
      const content = await readFile(rendered.path);
      const up = await uploadBase64ToStorage(
        { content, folder: "industry-debrief", filename: `industry-debrief-${req.date}-${id}.mp4`, contentType: "video/mp4" },
        identity,
      );
      url = up.url;
    } catch (err) {
      throw new DebriefError("UPLOAD_FAILED", (err as Error).message);
    } finally {
      await rendered.cleanup();
    }
    await db.update(industryDebriefVideos)
      .set({
        status: "done", stage: null, videoUrl: url, durationSeconds: rendered.durationSeconds,
        musicTrackId: rendered.musicTrackId, finishedAt: new Date(),
      })
      .where(eq(industryDebriefVideos.id, id));
    console.log(`[debrief] ${id} done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${url} (${rendered.durationSeconds.toFixed(2)}s, track ${rendered.musicTrackId})`);
    await updateRun(row.runId, "completed", identity).catch((err) => console.error(`[debrief] ${id} run ${row.runId} not closed:`, err));
  } catch (err) {
    const code = err instanceof DebriefError ? err.code : "RENDER_FAILED";
    const message = (err as Error).message;
    console.error(`[debrief] ${id} FAILED ${code}: ${message}`);
    await db.update(industryDebriefVideos)
      .set({ status: "failed", stage: null, errorCode: code, error: message, finishedAt: new Date() })
      .where(eq(industryDebriefVideos.id, id));
    await updateRun(row.runId, "failed", identity).catch((e) => console.error(`[debrief] ${id} run ${row.runId} not closed:`, e));
  }
}

/** Boot: re-queue renders a restart interrupted, fail the stale ones. Never awaited before listen(). */
export async function resumeDebriefJobs(now = Date.now()): Promise<void> {
  const open = await db.select().from(industryDebriefVideos)
    .where(inArray(industryDebriefVideos.status, ["queued", "rendering"]))
    .orderBy(industryDebriefVideos.createdAt);
  for (const row of open) {
    if (now - row.createdAt.getTime() <= RESUME_MAX_AGE_MS) {
      console.warn(`[debrief] ${row.id} was ${row.status} at boot: rendering it again`);
      await db.update(industryDebriefVideos).set({ status: "queued", stage: null }).where(eq(industryDebriefVideos.id, row.id));
      enqueueDebrief(row.id);
    } else {
      const message = `The process restarted during this render and it is older than ${RESUME_MAX_AGE_MS / 3600000}h: not resumed`;
      console.error(`[debrief] ${row.id} FAILED RENDER_INTERRUPTED`);
      await db.update(industryDebriefVideos)
        .set({ status: "failed", stage: null, errorCode: "RENDER_INTERRUPTED", error: message, finishedAt: new Date() })
        .where(eq(industryDebriefVideos.id, row.id));
      await updateRun(row.runId, "failed", identityOf(row)).catch((e) => console.error(`[debrief] run ${row.runId} not closed:`, e));
    }
  }
}

export function toDebriefResponse(row: IndustryDebriefVideo) {
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    videoUrl: row.videoUrl,
    durationSeconds: row.durationSeconds,
    musicTrackId: row.musicTrackId,
    errorCode: row.errorCode,
    error: row.error,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}
