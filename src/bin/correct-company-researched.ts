import { sql } from "../db/index.js";
import { firstResearchProducedAt } from "../lib/company-research-ledger.js";
import { planRunCorrection, type LedgerConsumption, type RunCorrection } from "../lib/company-research-correction.js";
import { COMPANY_RESEARCHED, type OutcomeDeclaration, type OutcomeOccurrence } from "../lib/run-outcomes.js";

/**
 * One-shot correction (COMPANY-RESEARCHED-PROVENANCE-1024): takes back the `company_researched`
 * consumptions this service declared on companies no run ever produced, and keeps the valid ones.
 * Rules: src/lib/company-research-correction.ts.
 *
 * Dry-run by default: prints, per run owner, how many consumptions are taken back and kept, and
 * cross-checks the plan against runs-service's own resolution (each consumption's `provenance`):
 * every one taken back must read `unknown`, every one kept `known`. `--apply` writes: scoped void
 * (consumed x company_researched) then re-declaration of the kept ones at the original instant, then
 * the stored body on our rows is rewritten to what the ledger holds. Runs another service owns are
 * voided through the declarer door once runs-service serves it; a refusal is counted, nothing else
 * is touched on that run. Re-runnable: a finished run plans nothing.
 *
 * `node dist/bin/correct-company-researched.js [--apply]` inside the container.
 */

const RUNS_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_KEY = process.env.RUNS_SERVICE_API_KEY || "";
const SERVICE = "content-generation-service";
const RUN_CHUNK = 150;
const VOIDED_BY = "content-generation-service COMPANY-RESEARCHED-PROVENANCE-1024";
const VOID_REASON =
  "company_researched consumed on companies no run declared producing (research never ran, or rode the serve's lead_found before 2026-10-23); only the companies lead-service declared are re-declared";

interface StoredRow {
  table: "email_generations" | "whatsapp_generations";
  id: string;
  run_id: string;
  outcomes: OutcomeDeclaration;
}

interface LedgerRow extends LedgerConsumption {
  runId: string;
  organizationId: string | null;
  serviceName: string;
  consumption: { provenance: "known" | "unknown" } | null;
}

async function runsFetch(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${RUNS_URL}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", "X-API-Key": RUNS_KEY, ...init.headers },
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status >= 500 && attempt < 4) throw new Error(`runs-service ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res;
    } catch (err) {
      if (attempt >= 4) throw err;
      console.error(`[correct] retry ${attempt} ${path.slice(0, 80)}:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function readStoredRows(): Promise<StoredRow[]> {
  const out: StoredRow[] = [];
  for (const table of ["email_generations", "whatsapp_generations"] as const) {
    // The run declared on: the backfill's (email_generations.outcomes_run_id), else our own generation run.
    const runCol = table === "email_generations" ? sql`COALESCE(outcomes_run_id, generation_run_id)` : sql`generation_run_id`;
    const rows = await sql<Array<Omit<StoredRow, "table">>>`
      SELECT id::text, ${runCol} AS run_id, outcomes FROM ${sql(table)}
      WHERE outcomes_declared_at IS NOT NULL AND ${runCol} IS NOT NULL
        AND outcomes @> ${JSON.stringify({ consumed: [{ outcomeKey: COMPANY_RESEARCHED }] })}::jsonb`;
    out.push(...rows.map((r) => ({ ...r, table })));
  }
  return out;
}

async function readLedgerConsumed(runIds: string[]): Promise<LedgerRow[]> {
  const out: LedgerRow[] = [];
  for (let i = 0; i < runIds.length; i += RUN_CHUNK) {
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ runIds: runIds.slice(i, i + RUN_CHUNK).join(","), direction: "consumed", limit: "1000" });
      if (cursor) q.set("cursor", cursor);
      const res = await runsFetch(`/internal/outcome-occurrences?${q}`);
      if (!res.ok) throw new Error(`runs-service GET /internal/outcome-occurrences ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const body = (await res.json()) as { occurrences: LedgerRow[]; nextCursor: string | null };
      out.push(...body.occurrences);
      cursor = body.nextCursor;
    } while (cursor);
  }
  return out;
}

const researched = (domains: string[]): OutcomeOccurrence[] =>
  domains.map((d) => ({ outcomeKey: COMPANY_RESEARCHED, subjectService: "lead-service", subjectId: d }));

async function applyRun(plan: Extract<RunCorrection, { consumedAt: string }>, orgId: string | null, produced: OutcomeOccurrence[]): Promise<string | null> {
  const headers: Record<string, string> = { "x-service-name": SERVICE, ...(orgId ? { "x-org-id": orgId } : {}) };
  if (plan.kind === "take_back") {
    const res = await runsFetch(`/v1/platform-runs/${plan.runId}/outcomes/void`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: VOID_REASON, voidedBy: VOIDED_BY, scope: { direction: "consumed", outcomeKey: COMPANY_RESEARCHED } }),
    });
    if (!res.ok) return `void ${res.status}: ${(await res.text()).slice(0, 200)}`;
  }
  const declare = plan.kind === "take_back" ? plan.desired : plan.missing;
  if (declare.length === 0) return null;
  const res = await runsFetch(`/v1/platform-runs/${plan.runId}/outcomes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ produced, consumed: researched(declare), occurredAt: plan.consumedAt }),
  });
  if (!res.ok) return `re-declare ${res.status}: ${(await res.text()).slice(0, 200)}`;
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await readStoredRows();
  const rowsByRun = new Map<string, StoredRow[]>();
  for (const r of rows) rowsByRun.set(r.run_id, [...(rowsByRun.get(r.run_id) ?? []), r]);
  const runIds = [...rowsByRun.keys()];
  const ledger = await readLedgerConsumed(runIds);
  const ledgerByRun = new Map<string, LedgerRow[]>();
  for (const o of ledger) ledgerByRun.set(o.runId, [...(ledgerByRun.get(o.runId) ?? []), o]);

  const domains = [...new Set([...rows.flatMap((r) => r.outcomes.consumed.filter((o) => o.outcomeKey === COMPANY_RESEARCHED).map((o) => o.subjectId)), ...ledger.filter((o) => o.outcomeKey === COMPANY_RESEARCHED).map((o) => o.subjectId)])];
  const firstProduced = await firstResearchProducedAt(domains);

  const ledgerCR = ledger.filter((o) => o.outcomeKey === COMPANY_RESEARCHED);
  const unknownBefore = ledgerCR.filter((o) => o.consumption?.provenance !== "known");
  const stats = { runs: runIds.length, consumptionsBefore: ledgerCR.length, unknownBefore: unknownBefore.length, takenBack: 0, consumptionsAfter: 0, unproducedAfter: 0, redeclaredMissing: 0, unreadableRuns: 0, refusedRuns: 0, rowsRewritten: 0 };
  const byOwner = new Map<string, { takeBack: number; kept: number; runs: number }>();
  const mismatches: string[] = [];
  const refusals = new Map<string, number>();

  for (const runId of runIds) {
    const runRows = rowsByRun.get(runId)!;
    const onRun = ledgerByRun.get(runId) ?? [];
    const storedDomains = [...new Set(runRows.flatMap((r) => r.outcomes.consumed.filter((o) => o.outcomeKey === COMPANY_RESEARCHED).map((o) => o.subjectId)))];
    const plan = planRunCorrection({ runId, serviceName: onRun[0]?.serviceName ?? "", storedDomains, ledgerConsumed: onRun }, firstProduced);
    if (plan.kind === "unreadable") {
      stats.unreadableRuns++;
      continue;
    }
    const desired = plan.kind === "none" ? [...new Set(onRun.filter((o) => o.outcomeKey === COMPANY_RESEARCHED).map((o) => o.subjectId))] : plan.desired;
    // Cross-check with runs-service's own resolution: taken back = unknown, kept = known.
    for (const o of onRun.filter((c) => c.outcomeKey === COMPANY_RESEARCHED)) {
      const known = o.consumption?.provenance === "known";
      if (known !== desired.includes(o.subjectId)) mismatches.push(`${runId} ${o.subjectId}: plan ${desired.includes(o.subjectId) ? "keeps" : "takes back"}, runs-service says ${known ? "known" : "unknown"}`);
    }
    if (plan.kind !== "none") {
      const owner = plan.serviceName || "?";
      const s = byOwner.get(owner) ?? { takeBack: 0, kept: 0, runs: 0 };
      s.takeBack += plan.takeBack.length;
      s.kept += plan.desired.length - plan.missing.length;
      s.runs++;
      byOwner.set(owner, s);
      stats.takenBack += plan.takeBack.length;
      stats.redeclaredMissing += plan.missing.length;
    }
    // What the run holds once corrected: the desired companies, each produced (valid) by construction.
    stats.consumptionsAfter += desired.length;
    stats.unproducedAfter += desired.filter((d) => !firstProduced.has(d)).length;

    if (!apply) continue;
    if (plan.kind !== "none") {
      const produced = [...new Map(runRows.flatMap((r) => r.outcomes.produced).map((o) => [`${o.outcomeKey}|${o.subjectId}`, o])).values()];
      const failed = await applyRun(plan, onRun[0]?.organizationId ?? null, produced);
      if (failed) {
        stats.refusedRuns++;
        const key = `${plan.serviceName}: ${failed.split(":")[0]} ${failed.match(/"error":"([^"]+)"/)?.[1] ?? ""}`;
        refusals.set(key, (refusals.get(key) ?? 0) + 1);
        continue;
      }
    }
    // Our rows say what the ledger now holds for this run.
    for (const r of runRows) {
      const consumed = r.outcomes.consumed.filter((o) => o.outcomeKey !== COMPANY_RESEARCHED || desired.includes(o.subjectId));
      if (consumed.length === r.outcomes.consumed.length) continue;
      await sql`UPDATE ${sql(r.table)} SET outcomes = ${JSON.stringify({ ...r.outcomes, consumed })}::jsonb WHERE id = ${r.id}::uuid`;
      stats.rowsRewritten++;
    }
  }

  console.log(`${apply ? "APPLIED" : "DRY RUN"} COMPANY-RESEARCHED-PROVENANCE-1024`);
  console.log(JSON.stringify(stats, null, 2));
  for (const [owner, s] of byOwner) console.log(`  runs owned by ${owner}: ${s.runs} runs, ${s.takeBack} taken back, ${s.kept} kept`);
  console.log(`  after: ${stats.consumptionsAfter} consumptions, of which naming a company nobody produced: ${stats.unproducedAfter}`);
  console.log(`  cross-check with runs-service's resolution: ${mismatches.length} mismatch(es)`);
  for (const m of mismatches.slice(0, 20)) console.log(`    ${m}`);
  for (const [k, n] of refusals) console.log(`  refused: ${k} x${n}`);
  if (apply) {
    const after = (await readLedgerConsumed(runIds)).filter((o) => o.outcomeKey === COMPANY_RESEARCHED);
    console.log(`  re-read: ${after.length} company_researched consumptions on these runs, ${after.filter((o) => o.consumption?.provenance !== "known").length} of unknown provenance`);
  }
}

main()
  .then(() => sql.end())
  .catch(async (error) => {
    console.error(error);
    await sql.end();
    process.exit(1);
  });
