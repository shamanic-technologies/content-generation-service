/**
 * Every database read and write of the reels feature (REELS-1124), so routes and jobs hold no
 * query and the unit suites replace ONE module.
 *
 * A video's `transcript` (up to ~1 MB for 2 h) and a proposal's `request` / `response_raw` are
 * NEVER part of a row read: columns are selected explicitly, the transcript has its own read.
 * Schema access stays inside functions (unit suites replace schema.js wholesale).
 */
import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import * as schema from "../../db/schema.js";
import type { LibraryHook } from "./hooks.js";
import type { ParsedHook } from "./hook-sources.js";
import { hookId } from "./hook-sources.js";
import type { Transcript } from "./transcript.js";

function videoColumns() {
  const t = schema.videos;
  return {
    id: t.id, orgId: t.orgId, userId: t.userId, runId: t.runId, tracking: t.tracking, sourceUrl: t.sourceUrl,
    idempotencyKey: t.idempotencyKey, status: t.status, stage: t.stage, errorCode: t.errorCode, error: t.error,
    sourceFile: t.sourceFile, sizeBytes: t.sizeBytes, durationSeconds: t.durationSeconds, width: t.width, height: t.height,
    hasAudio: t.hasAudio, transcriptStatus: t.transcriptStatus, transcriptRef: t.transcriptRef,
    transcriptIdentity: t.transcriptIdentity, transcriptLanguage: t.transcriptLanguage, transcriptError: t.transcriptError,
    createdAt: t.createdAt, readyAt: t.readyAt, sourceDeletedAt: t.sourceDeletedAt,
  };
}
export type VideoRow = Omit<typeof schema.videos.$inferSelect, "transcript">;
export type ClipRow = typeof schema.videoClips.$inferSelect;
export type NewVideo = Pick<typeof schema.videos.$inferInsert, "orgId" | "userId" | "runId" | "tracking" | "sourceUrl" | "idempotencyKey">;
export type NewClip = Omit<typeof schema.videoClips.$inferInsert, "id" | "createdAt">;
export type VideoPatch = Partial<typeof schema.videos.$inferInsert>;
export type ClipPatch = Partial<typeof schema.videoClips.$inferInsert>;

// --------------------------------------------------------------------------- videos

export async function findVideo(orgId: string, id: string): Promise<VideoRow | undefined> {
  const t = schema.videos;
  const [row] = await db.select(videoColumns()).from(t).where(and(eq(t.orgId, orgId), eq(t.id, id)));
  return row;
}

export async function findVideoByKey(orgId: string, idempotencyKey: string): Promise<VideoRow | undefined> {
  const t = schema.videos;
  const [row] = await db.select(videoColumns()).from(t).where(and(eq(t.orgId, orgId), eq(t.idempotencyKey, idempotencyKey)));
  return row;
}

/** The newest video of this org downloaded from `sourceUrl` that is still usable (not failed, source not deleted). */
export async function findHeldVideoBySource(orgId: string, sourceUrl: string): Promise<VideoRow | undefined> {
  const t = schema.videos;
  const [row] = await db.select(videoColumns()).from(t)
    .where(and(eq(t.orgId, orgId), eq(t.sourceUrl, sourceUrl), ne(t.status, "failed"), isNull(t.sourceDeletedAt)))
    .orderBy(desc(t.createdAt)).limit(1);
  return row;
}

export async function getVideo(id: string): Promise<VideoRow | undefined> {
  const t = schema.videos;
  const [row] = await db.select(videoColumns()).from(t).where(eq(t.id, id));
  return row;
}

export async function insertVideo(values: NewVideo): Promise<VideoRow> {
  const [row] = await db.insert(schema.videos).values(values).returning(videoColumns());
  return row;
}

export async function updateVideo(id: string, patch: VideoPatch): Promise<void> {
  await db.update(schema.videos).set(patch).where(eq(schema.videos.id, id));
}

/** Moves a video's transcript from one state to another; false when another request got there first. */
export async function claimTranscript(id: string, from: string[], patch: VideoPatch): Promise<boolean> {
  const t = schema.videos;
  const rows = await db.update(t).set(patch).where(and(eq(t.id, id), inArray(t.transcriptStatus, from))).returning({ id: t.id });
  return rows.length > 0;
}

export async function readTranscript(videoId: string): Promise<Transcript | null> {
  const t = schema.videos;
  const [row] = await db.select({ transcript: t.transcript }).from(t).where(eq(t.id, videoId));
  return (row?.transcript as Transcript | null) ?? null;
}

export async function videosInStatus(statuses: string[]): Promise<VideoRow[]> {
  const t = schema.videos;
  return db.select(videoColumns()).from(t).where(inArray(t.status, statuses)).orderBy(t.createdAt);
}

export async function videosInTranscriptStatus(statuses: string[]): Promise<VideoRow[]> {
  const t = schema.videos;
  return db.select(videoColumns()).from(t).where(inArray(t.transcriptStatus, statuses)).orderBy(t.createdAt);
}

// --------------------------------------------------------------------------- clips

export async function findClip(orgId: string, id: string): Promise<ClipRow | undefined> {
  const t = schema.videoClips;
  const [row] = await db.select().from(t).where(and(eq(t.orgId, orgId), eq(t.id, id)));
  return row;
}

export async function findClipByKey(orgId: string, idempotencyKey: string): Promise<ClipRow | undefined> {
  const t = schema.videoClips;
  const [row] = await db.select().from(t).where(and(eq(t.orgId, orgId), eq(t.idempotencyKey, idempotencyKey)));
  return row;
}

export async function getClip(id: string): Promise<ClipRow | undefined> {
  const t = schema.videoClips;
  const [row] = await db.select().from(t).where(eq(t.id, id));
  return row;
}

export async function insertClip(values: NewClip): Promise<ClipRow> {
  const [row] = await db.insert(schema.videoClips).values(values).returning();
  return row;
}

export async function updateClip(id: string, patch: ClipPatch): Promise<void> {
  await db.update(schema.videoClips).set(patch).where(eq(schema.videoClips.id, id));
}

export async function clipsInStatus(statuses: string[]): Promise<ClipRow[]> {
  const t = schema.videoClips;
  return db.select().from(t).where(inArray(t.status, statuses)).orderBy(t.createdAt);
}

// --------------------------------------------------------------------------- proposals

export async function insertProposal(values: typeof schema.videoLlmProposals.$inferInsert): Promise<string> {
  const t = schema.videoLlmProposals;
  const [row] = await db.insert(t).values(values).returning({ id: t.id });
  return row.id;
}

export async function attachProposalToClip(proposalId: string, clipId: string): Promise<void> {
  const t = schema.videoLlmProposals;
  await db.update(t).set({ clipId }).where(eq(t.id, proposalId));
}

// --------------------------------------------------------------------------- hook library

function toLibraryHook(r: typeof schema.hookLibrary.$inferSelect): LibraryHook {
  return { id: r.id, source: r.source, sourceUrl: r.sourceUrl, category: r.category, template: r.template, evidence: r.evidence ?? null };
}

/** Active hooks, each source's in a stable order (templates by id, the rest most viewed first). */
export async function listActiveHooks(filter: { category?: string; limit?: number } = {}): Promise<{ hooks: LibraryHook[]; total: number }> {
  const t = schema.hookLibrary;
  const where = filter.category ? and(eq(t.active, true), eq(t.category, filter.category)) : eq(t.active, true);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t).where(where);
  const query = db.select().from(t).where(where).orderBy(t.source, sql`(${t.evidence}->>'views')::bigint DESC NULLS LAST`, t.id);
  const rows = filter.limit ? await query.limit(filter.limit) : await query;
  return { hooks: rows.map(toLibraryHook), total: n };
}

export async function countActiveHooks(): Promise<number> {
  const t = schema.hookLibrary;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(t).where(eq(t.active, true));
  return n;
}

/** Any hook by id, active or not (an old clip names a row since deactivated). */
export async function findHook(id: string): Promise<LibraryHook | undefined> {
  const t = schema.hookLibrary;
  const [row] = await db.select().from(t).where(eq(t.id, id));
  return row ? toLibraryHook(row) : undefined;
}

/**
 * One source's fresh set, in one transaction: each hook upserted by id (active again), every
 * other row of THAT source set inactive. Never deletes. Other sources' rows are not touched.
 */
export async function replaceSourceHooks(source: string, sourceUrl: string, hooks: ParsedHook[]): Promise<{ active: number; deactivated: number }> {
  const t = schema.hookLibrary;
  const now = new Date();
  const rows = [...new Map(hooks.map((h) => [hookId(source, h.template), h])).entries()].map(([id, h]) => ({
    id, source, sourceUrl, category: h.category ?? null, template: h.template, evidence: h.evidence ?? null, fetchedAt: now, active: true,
  }));
  if (!rows.length) throw new Error(`source ${source} parsed to no hook: its stored rows are left untouched`);
  return db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 200) {
      await tx.insert(t).values(rows.slice(i, i + 200)).onConflictDoUpdate({
        target: t.id,
        set: { sourceUrl: sql`excluded.source_url`, category: sql`excluded.category`, template: sql`excluded.template`, evidence: sql`excluded.evidence`, fetchedAt: sql`excluded.fetched_at`, active: sql`true` },
      });
    }
    const stale = await tx.update(t).set({ active: false })
      .where(and(eq(t.source, source), eq(t.active, true), notInArray(t.id, rows.map((r) => r.id))))
      .returning({ id: t.id });
    return { active: rows.length, deactivated: stale.length };
  });
}

// --------------------------------------------------------------------------- retention

export async function retentionRows() {
  const v = schema.videos;
  const c = schema.videoClips;
  const videos = await db.select({ id: v.id, status: v.status, readyAt: v.readyAt, sourceDeletedAt: v.sourceDeletedAt }).from(v);
  const clips = await db.select({ id: c.id, status: c.status, finishedAt: c.finishedAt, fileDeletedAt: c.fileDeletedAt, token: c.token }).from(c);
  return { videos, clips };
}
