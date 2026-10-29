import { and, asc, isNotNull, or, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations } from "../db/schema.js";
import { encodeCursor, type SequenceCursor } from "./sequence-feed-query.js";

/**
 * GET /internal/generations/recorded (FACTORY-P3-RECORD-SYSTEM-PROMPT): every email generation that
 * recorded its chat-service request, in write order, each with the full request it sent, what it
 * was built from, and what it stored. workflow-service's case recorder (`scripts/record-script-cases.mjs`)
 * turns each into a replay case of the `message_written` writer port.
 *
 * - Only rows with `chat_request` (written since drizzle/0048). Keyset on (created_at, id) over the
 *   partial index `idx_emailgen_recorded_created`; same opaque cursor as GET /internal/sequences.
 * - Rows younger than `settleSeconds` are held back (a row is stamped at insert START, see the feed).
 * - A row is ~60 KB with its request: the route caps `limit` (MAX_RECORDED_LIMIT).
 */

export const MAX_RECORDED_LIMIT = 100;

export interface RecordedGeneration {
  generationId: string;
  createdAt: string;
  orgId: string;
  brandIds: string[];
  campaignId: string;
  leadId: string | null;
  /** The caller's run (workflow-service's execute run). */
  runId: string;
  /** Our own `single-generation` run, parent of the chat-service completion. */
  generationRunId: string | null;
  featureSlug: string | null;
  workflowSlug: string | null;
  promptType: string | null;
  /** The concrete model id chat-service answered with (the request names what was ASKED). */
  model: string;
  tokensInput: number | null;
  tokensOutput: number | null;
  /** The /generate `variables` as received (buying signal included even when not quotable). */
  variables: unknown;
  /** The exact chat-service /complete body: { message, systemPrompt, responseSchema, provider, model }. */
  request: unknown;
  /** What the request was built from beyond variables: { promptTemplate, campaignContext, language, giveLists, instruction, clientCommsVoice }. */
  inputs: unknown;
  /** chat-service's answer of the last attempt, verbatim. */
  response: unknown;
  /** What was stored and served: subject + sequence. */
  output: { subject: string | null; sequence: unknown };
}

export interface RecordedGenerationsPage {
  generations: RecordedGeneration[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function readRecordedGenerations(opts: {
  from?: string;
  to?: string;
  runId?: string;
  cursor: SequenceCursor | null;
  limit: number;
  settleSeconds: number;
}): Promise<RecordedGenerationsPage> {
  const g = emailGenerations;
  const conditions: SQL[] = [
    isNotNull(g.chatRequest),
    sql`${g.createdAt} < now() - make_interval(secs => ${opts.settleSeconds})`,
  ];
  if (opts.from) conditions.push(sql`${g.createdAt} >= ${opts.from}::timestamptz`);
  if (opts.to) conditions.push(sql`${g.createdAt} < ${opts.to}::timestamptz`);
  if (opts.runId) conditions.push(or(eq(g.runId, opts.runId), eq(g.generationRunId, opts.runId))!);
  if (opts.cursor) {
    conditions.push(
      sql`(${g.createdAt}, ${g.id}) > (${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: g.id,
      createdAt: g.createdAt,
      createdAtText: sql<string>`${g.createdAt}::text`,
      orgId: g.orgId,
      brandIds: g.brandIds,
      campaignId: g.campaignId,
      leadId: g.leadId,
      runId: g.runId,
      generationRunId: g.generationRunId,
      featureSlug: g.featureSlug,
      workflowSlug: g.workflowSlug,
      promptType: g.promptType,
      model: g.model,
      tokensInput: g.tokensInput,
      tokensOutput: g.tokensOutput,
      variablesRaw: g.variablesRaw,
      chatRequest: g.chatRequest,
      chatRequestInputs: g.chatRequestInputs,
      responseRaw: g.responseRaw,
      subject: g.subject,
      sequence: g.sequence,
    })
    .from(g)
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
      leadId: r.leadId,
      runId: r.runId,
      generationRunId: r.generationRunId,
      featureSlug: r.featureSlug,
      workflowSlug: r.workflowSlug,
      promptType: r.promptType,
      model: r.model,
      tokensInput: r.tokensInput,
      tokensOutput: r.tokensOutput,
      variables: r.variablesRaw,
      request: r.chatRequest,
      inputs: r.chatRequestInputs,
      response: r.responseRaw,
      output: { subject: r.subject, sequence: r.sequence },
    })),
    // Caught up: hand the caller's cursor back so it never moves backwards.
    nextCursor: last ? encodeCursor({ createdAt: last.createdAtText, id: last.id }) : opts.cursor ? encodeCursor(opts.cursor) : null,
    hasMore,
  };
}
