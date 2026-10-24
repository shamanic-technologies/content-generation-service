/**
 * Sends the outcome declaration stored on a generation row to runs-service, and keeps sending
 * until it lands (COST-ACCOUNTING-1023-P1). See run-outcomes.ts for WHAT is declared.
 *
 * The write path stores the declaration body on the row (`outcomes`) in the same insert as the
 * generation, so a declaration can never be lost: the route fires one attempt in the background
 * after answering, and an in-process sweep re-sends every row still pending. A failed declaration
 * never fails or slows the write. runs-service is idempotent per (run, direction, key, subject),
 * so a replay is `already_recorded` and nothing is counted twice.
 *
 * - success (200 / 201) → `outcomes_declared_at`
 * - permanent refusal (400 / 404 / 409) → `outcomes_error`, logged loud, never retried
 * - anything else → logged loud, retried by the next sweep
 *
 * A `company_researched` consumption is sent only for a company lead-service declared as produced
 * on the ledger (COMPANY-RESEARCHED-PROVENANCE-1024, company-research-ledger.ts). lead-service
 * declares its research in the background of the serve, so a row younger than
 * `RESEARCH_DECLARATION_GRACE_MS` whose company is not on the ledger yet waits for the next sweep;
 * older, the consumption is dropped (logged) and the stored body is rewritten to what was sent.
 */
import { sql } from "../db/index.js";
import { producedResearchDomains } from "./company-research-ledger.js";
import {
  consumedResearchDomains,
  industryUpdateVideoDeclaration,
  withoutUnproducedResearch,
  postRunOutcomes,
  PermanentDeclarationError,
  type OutcomeDeclaration,
} from "./run-outcomes.js";

export type GenerationTable = "email_generations" | "whatsapp_generations";

const SWEEP_FIRST_TICK_MS = 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_BATCH = 200;
export const RESEARCH_DECLARATION_GRACE_MS = 15 * 60_000;

interface PendingRow {
  id: string;
  org_id: string;
  generation_run_id: string;
  outcomes: OutcomeDeclaration;
  /** created_at as postgres prints it. */
  created_at: string;
}

type DeclareResult = "declared" | "refused" | "failed" | "waiting";

async function declareRow(table: GenerationTable, row: PendingRow, now = Date.now()): Promise<DeclareResult> {
  try {
    let outcomes = row.outcomes;
    const domains = consumedResearchDomains(outcomes);
    if (domains.length > 0) {
      const produced = await producedResearchDomains(domains);
      const missing = domains.filter((d) => !produced.has(d));
      if (missing.length > 0) {
        if (now - new Date(row.created_at).getTime() < RESEARCH_DECLARATION_GRACE_MS) return "waiting";
        console.warn(`[outcomes] ${table} ${row.id}: no produced company_researched on the ledger for ${missing.join(", ")}: not consumed`);
        outcomes = withoutUnproducedResearch(outcomes, produced);
      }
    }
    const status = await postRunOutcomes(row.generation_run_id, row.org_id, outcomes);
    await sql`UPDATE ${sql(table)} SET outcomes = ${JSON.stringify(outcomes)}::jsonb, outcomes_declared_at = now() WHERE id = ${row.id}`;
    if (status === 200) console.log(`[outcomes] ${table} ${row.id}: already recorded on run ${row.generation_run_id}`);
    return "declared";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PermanentDeclarationError) {
      console.error(`[outcomes] DECLARATION REFUSED ${table} ${row.id} run=${row.generation_run_id}: ${message}`);
      await sql`UPDATE ${sql(table)} SET outcomes_error = ${message.slice(0, 1000)} WHERE id = ${row.id}`;
      return "refused";
    }
    console.error(`[outcomes] DECLARATION FAILED (will retry) ${table} ${row.id} run=${row.generation_run_id}: ${message}`);
    return "failed";
  }
}

/** One background attempt for a row just written. Never throws. */
export async function declareStoredOutcomes(table: GenerationTable, id: string): Promise<void> {
  try {
    const rows = await sql<PendingRow[]>`
      SELECT id, org_id::text AS org_id, generation_run_id, outcomes, created_at::text AS created_at FROM ${sql(table)}
      WHERE id = ${id} AND outcomes IS NOT NULL AND generation_run_id IS NOT NULL
        AND outcomes_declared_at IS NULL AND outcomes_error IS NULL`;
    if (rows[0]) await declareRow(table, rows[0]);
  } catch (err) {
    console.error(`[outcomes] DECLARATION FAILED (will retry) ${table} ${id}:`, err instanceof Error ? err.message : err);
  }
}

interface PendingRender {
  id: string;
  org_id: string;
  run_id: string;
  /** finished_at as postgres prints it: the instant the video was delivered. */
  finished_at: string;
}

/**
 * One delivered industry debrief video (LEDGER-HISTORY-1024): `industry_update_video` produced on
 * the render's own run, dated when it was delivered (`occurredAt` = finished_at), so a render
 * delivered before this existed counts on its own day. The declaration is derived from the row
 * (`status = 'done'`), never stored apart: the row IS the record of what was made.
 */
async function declareRender(row: PendingRender): Promise<DeclareResult> {
  const occurredAt = new Date(row.finished_at).toISOString();
  try {
    await postRunOutcomes(row.run_id, row.org_id, industryUpdateVideoDeclaration(row.id), occurredAt);
    await sql`UPDATE industry_debrief_videos SET outcomes_declared_at = now() WHERE id = ${row.id}`;
    return "declared";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PermanentDeclarationError) {
      console.error(`[outcomes] DECLARATION REFUSED industry_debrief_videos ${row.id} run=${row.run_id}: ${message}`);
      await sql`UPDATE industry_debrief_videos SET outcomes_error = ${message.slice(0, 1000)} WHERE id = ${row.id}`;
      return "refused";
    }
    console.error(`[outcomes] DECLARATION FAILED (will retry) industry_debrief_videos ${row.id} run=${row.run_id}: ${message}`);
    return "failed";
  }
}

// `renderShips` (lib/debrief/ships.ts) on the stored row: never a dry run, always under a campaign
// (DRY-RUN-RENDER-1024). A render that does not ship is a staff test, never an outcome.
const pendingRenders = (id?: string) => sql<PendingRender[]>`
  SELECT id::text, org_id::text AS org_id, run_id, finished_at::text AS finished_at FROM industry_debrief_videos
  WHERE status = 'done' AND finished_at IS NOT NULL AND outcomes_declared_at IS NULL AND outcomes_error IS NULL
    AND COALESCE(request->>'dryRun', 'false') <> 'true' AND COALESCE(tracking->>'campaignId', '') <> ''
    ${id ? sql`AND id = ${id}::uuid` : sql``}
  ORDER BY created_at LIMIT ${SWEEP_BATCH}`;

/** One background attempt for a render just delivered. Never throws. */
export async function declareRenderOutcomes(id: string): Promise<void> {
  try {
    const [row] = await pendingRenders(id);
    if (row) await declareRender(row);
  } catch (err) {
    console.error(`[outcomes] DECLARATION FAILED (will retry) industry_debrief_videos ${id}:`, err instanceof Error ? err.message : err);
  }
}

/** Sends every pending declaration (both generation tables, delivered renders), oldest first, one batch each. */
export async function sweepPendingOutcomes(): Promise<{ declared: number; refused: number; failed: number; waiting: number }> {
  const totals = { declared: 0, refused: 0, failed: 0, waiting: 0 };
  for (const row of await pendingRenders()) totals[await declareRender(row)]++;
  for (const table of ["email_generations", "whatsapp_generations"] as const) {
    const rows = await sql<PendingRow[]>`
      SELECT id, org_id::text AS org_id, generation_run_id, outcomes, created_at::text AS created_at FROM ${sql(table)}
      WHERE outcomes IS NOT NULL AND generation_run_id IS NOT NULL
        AND outcomes_declared_at IS NULL AND outcomes_error IS NULL
      ORDER BY created_at LIMIT ${SWEEP_BATCH}`;
    for (const row of rows) totals[await declareRow(table, row)]++;
  }
  return totals;
}

let sweeping = false;

/** In-process sweep: first tick ~60 s after boot, then every 5 min, single flight. */
export function startOutcomeDeclarationSweep(): void {
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const t = await sweepPendingOutcomes();
      if (t.declared || t.refused || t.failed || t.waiting) console.log(`[outcomes] sweep: declared=${t.declared} refused=${t.refused} failed=${t.failed} waiting=${t.waiting}`);
    } catch (err) {
      console.error("[outcomes] sweep failed:", err instanceof Error ? err.message : err);
    } finally {
      sweeping = false;
    }
  };
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), SWEEP_INTERVAL_MS).unref();
  }, SWEEP_FIRST_TICK_MS).unref();
}
