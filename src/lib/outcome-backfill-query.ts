import { sql } from "../db/index.js";
import { REVISITED_ERROR_PREFIXES } from "./outcome-backfill.js";

/**
 * The backfill's read of stored emails not yet handled (COST-BACKFILL-1023-CONTENTGEN-RUN).
 *
 * `created_at` is selected as TEXT and the cursor carries that text: drizzle's postgres-js driver
 * turns postgres.js's timestamp parsers off, so the column arrives as a string, never a Date (the
 * first prod run died on `created_at.toISOString is not a function`, 2026-10-24). The text also keeps
 * postgres's microseconds, which a Date would round to the millisecond and so skip or repeat rows
 * written in the same millisecond at a page edge.
 */
export interface UnhandledGeneration {
  id: string;
  org_id: string;
  lead_id: string | null;
  feature_slug: string | null;
  campaign_id: string | null;
  variables_raw: Record<string, unknown> | null;
  brand_ids: string[];
  generation_run_id: string;
  /** created_at as postgres prints it (microsecond precision, offset included). */
  created_at: string;
}

export interface GenerationCursor {
  createdAt: string;
  id: string;
}

export async function readUnhandledGenerations(cursor: GenerationCursor | null, limit: number): Promise<UnhandledGeneration[]> {
  return sql<UnhandledGeneration[]>`
    SELECT id::text, org_id::text, lead_id, feature_slug, NULLIF(campaign_id, '') AS campaign_id, variables_raw, brand_ids, generation_run_id, created_at::text AS created_at
    FROM email_generations
    WHERE generation_run_id IS NOT NULL AND outcomes IS NULL AND outcomes_declared_at IS NULL AND outcomes_error IS NULL
      ${cursor ? sql`AND (created_at, id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql``}
    ORDER BY created_at, id LIMIT ${limit}`;
}

export function cursorAfter(rows: UnhandledGeneration[]): GenerationCursor {
  const last = rows[rows.length - 1];
  return { createdAt: last.created_at, id: last.id };
}

/**
 * Rows the first backfill marked with a reason its rules no longer give (LEDGER-RESIDUAL-1025,
 * `REVISITED_ERROR_PREFIXES`): read again and decided anew. Every new decision writes a mark outside
 * that set (declared, or another reason), so a replay reads nothing.
 */
export async function readRevisitedGenerations(cursor: GenerationCursor | null, limit: number): Promise<UnhandledGeneration[]> {
  const prefixes = REVISITED_ERROR_PREFIXES.map((p) => `${p.replace(/[\\%_]/g, "\\$&")}%`);
  return sql<UnhandledGeneration[]>`
    SELECT id::text, org_id::text, lead_id, feature_slug, NULLIF(campaign_id, '') AS campaign_id, variables_raw, brand_ids, generation_run_id, created_at::text AS created_at
    FROM email_generations
    WHERE generation_run_id IS NOT NULL AND outcomes_declared_at IS NULL AND outcomes_error LIKE ANY(${sql.array(prefixes)}::text[])
      ${cursor ? sql`AND (created_at, id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql``}
    ORDER BY created_at, id LIMIT ${limit}`;
}
