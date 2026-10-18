import { and, asc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations } from "../db/schema.js";
import { resolveGenerationBody } from "./generation-body.js";
import { firstEmailShape, type FirstEmailShape } from "./first-email-shape.js";

/**
 * The fleet-wide sequence feed behind GET /internal/sequences: one entry per generated
 * sequence (campaign x lead) of one feature, every org, since inception, in write order,
 * followed incrementally with an opaque cursor.
 *
 * - Keyset paging on (created_at, id), served by `idx_emailgen_feature_created`
 *   (feature_slug, created_at, id): a page is an index range scan, never a table scan, and a
 *   caller resuming from its cursor reads only what was written since.
 * - Rows younger than `settleSeconds` are not served yet. `created_at` is stamped when the
 *   insert STARTS, so a row stamped a few ms earlier can still be uncommitted when a later one
 *   is visible; serving the later one would move the cursor past the earlier one forever.
 *   A short settle window makes the cursor safe without any extra state.
 * - Only the columns the entry needs are selected: never prompt_raw / response_raw /
 *   variables_raw (the bulk of a ~52 KB row).
 */

export interface SequenceCursor {
  /** created_at as postgres prints it (microsecond precision, offset included). */
  createdAt: string;
  id: string;
}

export function encodeCursor(c: SequenceCursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf8").toString("base64url");
}

/** `null` when the string is not a cursor this service issued. */
export function decodeCursor(raw: string): SequenceCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const sep = decoded.lastIndexOf("|");
  if (sep <= 0) return null;
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/.test(createdAt)) return null;
  return { createdAt, id };
}

export interface SequenceFeedEntry {
  generationId: string;
  orgId: string;
  campaignId: string;
  leadId: string;
  model: string;
  promptType: string | null;
  workflowSlug: string | null;
  createdAt: string;
  runId: string;
  generationRunId: string | null;
  firstEmail: FirstEmailShape | null;
}

export interface SequenceFeedPage {
  sequences: SequenceFeedEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function readSequenceFeed(opts: {
  featureSlug: string;
  cursor: SequenceCursor | null;
  limit: number;
  settleSeconds: number;
}): Promise<SequenceFeedPage> {
  const g = emailGenerations;
  const conditions: SQL[] = [
    eq(g.featureSlug, opts.featureSlug),
    isNotNull(g.leadId),
    sql`${g.createdAt} < now() - make_interval(secs => ${opts.settleSeconds})`,
  ];
  if (opts.cursor) {
    conditions.push(
      sql`(${g.createdAt}, ${g.id}) > (${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: g.id,
      orgId: g.orgId,
      campaignId: g.campaignId,
      leadId: g.leadId,
      model: g.model,
      promptType: g.promptType,
      workflowSlug: g.workflowSlug,
      createdAt: g.createdAt,
      createdAtText: sql<string>`${g.createdAt}::text`,
      runId: g.runId,
      generationRunId: g.generationRunId,
      leadFirstName: g.leadFirstName,
      bodyText: g.bodyText,
      bodyHtml: g.bodyHtml,
      sequence: g.sequence,
    })
    .from(g)
    .where(and(...conditions))
    .orderBy(asc(g.createdAt), asc(g.id))
    .limit(opts.limit + 1);

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;

  const sequences = page.map((r): SequenceFeedEntry => {
    const body = resolveGenerationBody({ bodyText: r.bodyText, bodyHtml: r.bodyHtml, sequence: r.sequence });
    return {
      generationId: r.id,
      orgId: r.orgId,
      campaignId: r.campaignId,
      leadId: r.leadId as string,
      model: r.model,
      promptType: r.promptType,
      workflowSlug: r.workflowSlug,
      createdAt: new Date(r.createdAt).toISOString(),
      runId: r.runId,
      generationRunId: r.generationRunId,
      firstEmail: firstEmailShape(body.bodyText, r.leadFirstName),
    };
  });

  const last = page[page.length - 1];
  const nextCursor = last
    ? encodeCursor({ createdAt: last.createdAtText, id: last.id })
    : opts.cursor
      ? encodeCursor(opts.cursor)
      : null;

  return { sequences, nextCursor, hasMore };
}
