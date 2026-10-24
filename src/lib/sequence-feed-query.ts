import { and, asc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations, whatsappGenerations } from "../db/schema.js";
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
 * - WhatsApp messages written with a template (whatsapp_generations, WA-TEMPLATES-1023) are served
 *   in the same feed, channel `whatsapp`, when they were sent (decision write). Both tables are read
 *   from the same cursor and merged in (created_at, id) order, so one cursor covers both.
 * - Each entry names the completion run(s) that wrote it and the tokens recorded for it
 *   (MODEL-RUN-COST-1024-CG). The match is stored on the row by src/lib/completion-run-sweep.ts; a row
 *   not matched yet ENDS the page (hasMore false), so a consumer never moves its cursor past an entry
 *   served without its answer. The sweep matches a new row within a minute or two.
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
  completionRunIds: string[] | null;
  completionRunsReason: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  channel: "email" | "whatsapp";
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

  const emailRows = await db
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
      completionRunIds: g.completionRunIds,
      completionRunsReason: g.completionRunsReason,
      tokensInput: g.tokensInput,
      tokensOutput: g.tokensOutput,
      leadFirstName: g.leadFirstName,
      bodyText: g.bodyText,
      bodyHtml: g.bodyHtml,
      sequence: g.sequence,
    })
    .from(g)
    .where(and(...conditions))
    .orderBy(asc(g.createdAt), asc(g.id))
    .limit(opts.limit + 1);

  const w = whatsappGenerations;
  const waConditions: SQL[] = [
    eq(w.featureSlug, opts.featureSlug),
    eq(w.decision, "write"),
    isNotNull(w.leadId),
    sql`${w.createdAt} < now() - make_interval(secs => ${opts.settleSeconds})`,
  ];
  if (opts.cursor) {
    waConditions.push(
      sql`(${w.createdAt}, ${w.id}) > (${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`,
    );
  }
  const waRows = await db
    .select({
      id: w.id,
      orgId: w.orgId,
      campaignId: w.campaignId,
      leadId: w.leadId,
      model: w.model,
      promptType: w.promptType,
      workflowSlug: w.workflowSlug,
      createdAt: w.createdAt,
      createdAtText: sql<string>`${w.createdAt}::text`,
      runId: w.runId,
      completionRunIds: w.completionRunIds,
      completionRunsReason: w.completionRunsReason,
      tokensInput: w.tokensInput,
      tokensOutput: w.tokensOutput,
    })
    .from(w)
    .where(and(...waConditions))
    .orderBy(asc(w.createdAt), asc(w.id))
    .limit(opts.limit + 1);

  const merged = [
    ...emailRows.map((r) => ({ r, entry: (): SequenceFeedEntry => {
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
        ...completionFields(r),
        channel: "email",
        firstEmail: firstEmailShape(body.bodyText, r.leadFirstName),
      };
    } })),
    ...waRows.map((r) => ({ r, entry: (): SequenceFeedEntry => ({
      generationId: r.id,
      orgId: r.orgId,
      campaignId: r.campaignId,
      leadId: r.leadId as string,
      model: r.model,
      promptType: r.promptType,
      workflowSlug: r.workflowSlug,
      createdAt: new Date(r.createdAt).toISOString(),
      runId: r.runId,
      generationRunId: null,
      ...completionFields(r),
      channel: "whatsapp",
      firstEmail: null,
    }) })),
  ].sort((a, b) => compareKeys(a.r, b.r));

  // A row not matched yet ends the page: everything before it is served, nothing after it.
  const pending = merged.findIndex((x) => x.r.completionRunIds == null && x.r.completionRunsReason == null);
  const servable = pending === -1 ? merged : merged.slice(0, pending);
  const hasMore = servable.length > opts.limit;
  const kept = servable.slice(0, opts.limit);
  const page = kept.map((x) => x.r);
  const sequences = kept.map((x) => x.entry());

  const last = page[page.length - 1];
  const nextCursor = last
    ? encodeCursor({ createdAt: last.createdAtText, id: last.id })
    : opts.cursor
      ? encodeCursor(opts.cursor)
      : null;

  return { sequences, nextCursor, hasMore };
}

function completionFields(r: {
  completionRunIds: string[] | null;
  completionRunsReason: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
}): Pick<SequenceFeedEntry, "completionRunIds" | "completionRunsReason" | "tokensInput" | "tokensOutput"> {
  return {
    completionRunIds: r.completionRunIds,
    completionRunsReason: r.completionRunIds ? null : r.completionRunsReason,
    tokensInput: r.tokensInput,
    tokensOutput: r.tokensOutput,
  };
}

/** (created_at, id) order, as postgres compares them (microsecond text, then uuid). */
function compareKeys(a: { createdAt: Date | string; createdAtText: string; id: string }, b: { createdAt: Date | string; createdAtText: string; id: string }): number {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (ta !== tb) return ta - tb;
  const ma = micros(a.createdAtText);
  const mb = micros(b.createdAtText);
  if (ma !== mb) return ma - mb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function micros(text: string): number {
  const m = /\.(\d{1,6})/.exec(text);
  return m ? Number(m[1].padEnd(6, "0")) : 0;
}
