/**
 * Reads of `thread_generations` (THREADS-IDEAS-AB).
 *
 * - `readThreadGenerations`: GET /internal/thread-generations, every org, oldest first, keyset on
 *   (created_at, id) with the same opaque cursor and 60 s settle as GET /internal/sequences. Each row names the
 *   template version, its dynasty (one template = one dynasty) and the model that wrote: features-service
 *   credits each post's outcomes (views, engagements, visits, signups) to the run that wrote it.
 * - `readThreadOutputs`: the last threads written with some template types, in the shape of a template's
 *   outputs (merged into the template / dynasty outputs like WhatsApp's).
 */
import { and, asc, desc, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { threadGenerations, templateDynasties, templateDynastyVersions } from "../db/schema.js";
import { encodeCursor, type SequenceCursor } from "./sequence-feed-query.js";
import type { TemplateOutput } from "./catalogue-status-query.js";

export interface ThreadGenerationEntry {
  generationId: string;
  createdAt: string;
  orgId: string;
  brandIds: string[];
  campaignId: string;
  /** The caller's run: the workflow run that publishes the thread. */
  runId: string;
  workflowSlug: string | null;
  featureSlug: string | null;
  promptType: string;
  templateDynasty: { slug: string; name: string; position: number } | null;
  /** The concrete model id chat-service answered with. */
  model: string;
  subject: string;
  post: string;
  replies: string[];
  /** A staff dry run: written, never published. */
  dryRun: boolean;
}

export interface ThreadGenerationsPage {
  generations: ThreadGenerationEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function readThreadGenerations(opts: {
  since?: string;
  cursor: SequenceCursor | null;
  limit: number;
  settleSeconds: number;
}): Promise<ThreadGenerationsPage> {
  const g = threadGenerations;
  const v = templateDynastyVersions;
  const d = templateDynasties;
  const conditions: SQL[] = [sql`${g.createdAt} < now() - make_interval(secs => ${opts.settleSeconds})`];
  if (opts.since) conditions.push(sql`${g.createdAt} >= ${opts.since}::timestamptz`);
  if (opts.cursor) {
    conditions.push(sql`(${g.createdAt}, ${g.id}) > (${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`);
  }
  const rows = await db
    .select({
      id: g.id,
      createdAt: g.createdAt,
      createdAtText: sql<string>`${g.createdAt}::text`,
      orgId: g.orgId,
      brandIds: g.brandIds,
      campaignId: g.campaignId,
      runId: g.runId,
      workflowSlug: g.workflowSlug,
      featureSlug: g.featureSlug,
      promptType: g.promptType,
      model: g.model,
      subject: g.subject,
      post: g.post,
      replies: g.replies,
      dryRun: g.dryRun,
      dynastySlug: d.slug,
      dynastyName: d.name,
      position: v.position,
    })
    .from(g)
    .leftJoin(v, sql`${v.promptType} = ${g.promptType}`)
    .leftJoin(d, sql`${d.slug} = ${v.dynastySlug}`)
    .where(and(...conditions))
    .orderBy(asc(g.createdAt), asc(g.id))
    .limit(opts.limit + 1);
  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    generations: page.map((r) => ({
      generationId: r.id,
      createdAt: new Date(r.createdAt).toISOString(),
      orgId: r.orgId,
      brandIds: r.brandIds,
      campaignId: r.campaignId,
      runId: r.runId,
      workflowSlug: r.workflowSlug,
      featureSlug: r.featureSlug,
      promptType: r.promptType,
      templateDynasty:
        r.dynastySlug && r.dynastyName && r.position !== null ? { slug: r.dynastySlug, name: r.dynastyName, position: r.position } : null,
      model: r.model,
      subject: r.subject,
      post: r.post,
      replies: Array.isArray(r.replies) ? r.replies : [],
      dryRun: r.dryRun,
    })),
    // Caught up = the input cursor handed back (the feed's convention).
    nextCursor: last ? encodeCursor({ createdAt: last.createdAtText, id: last.id }) : opts.cursor ? encodeCursor(opts.cursor) : null,
    hasMore,
  };
}

/** The last threads written with some template types, as template outputs: no subject line, the main post then each reply. */
export async function readThreadOutputs(types: string[], limit: number): Promise<Array<TemplateOutput & { promptType: string }>> {
  if (types.length === 0) return [];
  const g = threadGenerations;
  const rows = await db
    .select({ id: g.id, createdAt: g.createdAt, promptType: g.promptType, workflowSlug: g.workflowSlug, model: g.model, subject: g.subject, post: g.post, replies: g.replies })
    .from(g)
    .where(inArray(g.promptType, types))
    .orderBy(desc(g.createdAt), desc(g.id))
    .limit(limit);
  return rows.map((r) => ({
    generationId: r.id,
    createdAt: new Date(r.createdAt).toISOString(),
    promptType: r.promptType,
    workflowSlug: r.workflowSlug,
    model: r.model,
    subject: r.subject || null,
    emails: [r.post, ...(Array.isArray(r.replies) ? r.replies : [])].map((bodyText, i) => ({ step: i + 1, bodyText, daysSinceLastStep: 0 })),
  }));
}
