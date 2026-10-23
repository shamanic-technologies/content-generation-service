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
 */
import { sql } from "../db/index.js";
import { postRunOutcomes, PermanentDeclarationError, type OutcomeDeclaration } from "./run-outcomes.js";

export type GenerationTable = "email_generations" | "whatsapp_generations";

const SWEEP_FIRST_TICK_MS = 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_BATCH = 200;

interface PendingRow {
  id: string;
  org_id: string;
  generation_run_id: string;
  outcomes: OutcomeDeclaration;
}

async function declareRow(table: GenerationTable, row: PendingRow): Promise<"declared" | "refused" | "failed"> {
  try {
    const status = await postRunOutcomes(row.generation_run_id, row.org_id, row.outcomes);
    await sql`UPDATE ${sql(table)} SET outcomes_declared_at = now() WHERE id = ${row.id}`;
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
      SELECT id, org_id::text AS org_id, generation_run_id, outcomes FROM ${sql(table)}
      WHERE id = ${id} AND outcomes IS NOT NULL AND generation_run_id IS NOT NULL
        AND outcomes_declared_at IS NULL AND outcomes_error IS NULL`;
    if (rows[0]) await declareRow(table, rows[0]);
  } catch (err) {
    console.error(`[outcomes] DECLARATION FAILED (will retry) ${table} ${id}:`, err instanceof Error ? err.message : err);
  }
}

/** Sends every pending declaration of both tables, oldest first, one batch per table. */
export async function sweepPendingOutcomes(): Promise<{ declared: number; refused: number; failed: number }> {
  const totals = { declared: 0, refused: 0, failed: 0 };
  for (const table of ["email_generations", "whatsapp_generations"] as const) {
    const rows = await sql<PendingRow[]>`
      SELECT id, org_id::text AS org_id, generation_run_id, outcomes FROM ${sql(table)}
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
      if (t.declared || t.refused || t.failed) console.log(`[outcomes] sweep: declared=${t.declared} refused=${t.refused} failed=${t.failed}`);
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
