import { sql } from "../db/index.js";
import {
  decideBackfill,
  mergeByRun,
  packBatches,
  type BackfillDecision,
  type BackfillRun,
  type BatchRunEntry,
} from "../lib/outcome-backfill.js";

/**
 * One-shot backfill (COST-BACKFILL-1023-CONTENTGEN): declares `message_written` on the past run that
 * paid for each stored email, through runs-service's backfill door
 * (`POST /v1/platform-runs/outcomes/batch`, `occurredAt: "run_started_at"`), so a past email counts
 * as declared when it was written. Rules: src/lib/outcome-backfill.ts.
 *
 * Dry-run by default (prints what it would declare and what stays unreadable, per reason);
 * `--apply` writes. Compiled into dist so it runs inside the container:
 * `node dist/bin/backfill-generation-outcomes.js [--apply]`.
 *
 * Resumable and idempotent: a row is marked on its own table once handled (`outcomes_declared_at`
 * + `outcomes_run_id`, or `outcomes_error` = `backfill: <reason>`), and only unmarked rows are read,
 * so a re-run reads nothing new and writes nothing. runs-service itself answers a replay
 * `already_recorded`. A marked row never reaches the P1 sweep (it needs `outcomes` set and both
 * marks empty).
 */

const RUNS_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_KEY = process.env.RUNS_SERVICE_API_KEY || "";
const CHUNK = 400;
const FETCH_CHUNK = 100;

interface Row {
  id: string;
  org_id: string;
  lead_id: string | null;
  feature_slug: string | null;
  variables_raw: Record<string, unknown> | null;
  generation_run_id: string;
  created_at: Date;
}

interface FetchedRun extends BackfillRun {
  descendantRuns?: BackfillRun[];
}

async function runsFetch(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${RUNS_URL}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", "X-API-Key": RUNS_KEY, ...init.headers },
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status >= 500 && attempt < 4) throw new Error(`runs-service ${path} ${res.status}: ${await res.text()}`);
      return res;
    } catch (err) {
      if (attempt >= 4) throw err;
      console.error(`[backfill] retry ${attempt} ${path}:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** Runs with their costs (and descendant tree) read under their org; missing ones are absent. */
async function fetchRuns(orgId: string, runIds: string[]): Promise<Map<string, FetchedRun>> {
  const out = new Map<string, FetchedRun>();
  for (let i = 0; i < runIds.length; i += FETCH_CHUNK) {
    const ids = runIds.slice(i, i + FETCH_CHUNK);
    const res = await runsFetch("/v1/runs/batch", {
      method: "POST",
      headers: { "x-org-id": orgId },
      body: JSON.stringify({ runIds: ids }),
    });
    if (!res.ok) throw new Error(`runs-service POST /v1/runs/batch ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { runs: FetchedRun[] };
    for (const r of body.runs) out.set(r.id, r);
  }
  return out;
}

async function decideChunk(rows: Row[]): Promise<Map<string, BackfillDecision>> {
  const decisions = new Map<string, BackfillDecision>();
  const byOrg = new Map<string, Row[]>();
  for (const r of rows) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r]);
  for (const [orgId, orgRows] of byOrg) {
    const genRuns = await fetchRuns(orgId, [...new Set(orgRows.map((r) => r.generation_run_id))]);
    const parentIds = [...new Set([...genRuns.values()].map((r) => r.parentRunId).filter((p): p is string => !!p))];
    const parents = await fetchRuns(orgId, parentIds);
    for (const row of orgRows) {
      const gen = genRuns.get(row.generation_run_id);
      if (!gen) {
        decisions.set(row.id, { kind: "unreadable", reason: "generation run not readable under the email's org" });
        continue;
      }
      const parent = gen.parentRunId ? parents.get(gen.parentRunId) : undefined;
      decisions.set(row.id, decideBackfill({ id: row.id, leadId: row.lead_id, featureSlug: row.feature_slug, variables: row.variables_raw }, gen, parent));
    }
  }
  return decisions;
}

/** Declares the entries; returns the rows refused for good, with the reason. */
async function declare(entries: BatchRunEntry[]): Promise<{ declared: Set<string>; refused: Map<string, string> }> {
  const declared = new Set<string>();
  const refused = new Map<string, string>();
  for (const batch of packBatches(entries)) {
    let pending = batch;
    while (pending.length > 0) {
      const res = await runsFetch("/v1/platform-runs/outcomes/batch", {
        method: "POST",
        headers: { "x-service-name": "content-generation-service" },
        body: JSON.stringify({ runs: pending }),
      });
      const text = await res.text();
      if (res.ok) {
        for (const e of pending) declared.add(e.runId);
        break;
      }
      const body = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })();
      const bad: Array<{ runId: string; reason?: string }> =
        res.status === 422 ? body?.details?.invalid ?? [] : res.status === 409 ? (body?.conflicts ?? []).map((c: { runId: string }) => ({ runId: c.runId, reason: "conflict" })) : [];
      if (bad.length === 0) throw new Error(`runs-service outcomes/batch ${res.status}: ${text.slice(0, 1000)}`);
      const badRuns = new Map(bad.map((b) => [b.runId, b.reason ?? String(res.status)]));
      for (const [runId, reason] of badRuns) refused.set(runId, `backfill: runs-service refused (${reason})`);
      pending = pending.filter((e) => !badRuns.has(e.runId));
    }
  }
  return { declared, refused };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const totals = new Map<string, number>();
  const add = (key: string) => totals.set(key, (totals.get(key) ?? 0) + 1);
  const runsDeclared: string[] = [];

  let cursor: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const rows: Row[] = await sql<Row[]>`
      SELECT id::text, org_id::text, lead_id, feature_slug, variables_raw, generation_run_id, created_at
      FROM email_generations
      WHERE generation_run_id IS NOT NULL AND outcomes IS NULL AND outcomes_declared_at IS NULL AND outcomes_error IS NULL
        ${cursor ? sql`AND (created_at, id) > (${cursor.createdAt}, ${cursor.id}::uuid)` : sql``}
      ORDER BY created_at, id LIMIT ${CHUNK}`;
    if (rows.length === 0) break;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };

    const decisions = await decideChunk(rows);
    const toDeclare: Array<{ rowId: string; runId: string; declaration: BackfillDecision & { kind: "declare" } }> = [];
    const errors = new Map<string, string>();
    for (const row of rows) {
      const d = decisions.get(row.id)!;
      if (d.kind === "declare") {
        add(`declare via ${d.via}`);
        toDeclare.push({ rowId: row.id, runId: d.runId, declaration: d });
      } else {
        add(`${d.kind}: ${d.reason}`);
        errors.set(row.id, `backfill: ${d.reason}`);
      }
    }
    runsDeclared.push(...new Set(toDeclare.map((t) => t.runId)));
    if (!apply) continue;

    const { declared, refused } = await declare(mergeByRun(toDeclare.map((t) => ({ runId: t.runId, declaration: t.declaration.declaration }))));
    let marked = 0;
    for (const t of toDeclare) {
      if (declared.has(t.runId)) {
        await sql`UPDATE email_generations SET outcomes = ${JSON.stringify(t.declaration.declaration)}::jsonb, outcomes_declared_at = now(), outcomes_run_id = ${t.runId} WHERE id = ${t.rowId}::uuid`;
        marked++;
      } else if (refused.has(t.runId)) errors.set(t.rowId, refused.get(t.runId)!);
    }
    for (const [id, reason] of errors) {
      await sql`UPDATE email_generations SET outcomes_error = ${reason.slice(0, 1000)} WHERE id = ${id}::uuid`;
    }
    console.log(`[backfill] up to ${last.created_at.toISOString()}: declared ${marked} emails on ${declared.size} runs, refused runs ${refused.size}, unreadable/skipped ${errors.size}`);
  }

  console.log(`${apply ? "APPLIED" : "DRY RUN"}: emails per decision (${new Set(runsDeclared).size} distinct runs to declare on)`);
  for (const [k, n] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  const [left] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM email_generations
    WHERE generation_run_id IS NOT NULL AND outcomes IS NULL AND outcomes_declared_at IS NULL AND outcomes_error IS NULL`;
  console.log(`emails still unhandled after this run: ${left.n}`);
}

main()
  .then(() => sql.end())
  .catch(async (error) => {
    console.error(error);
    await sql.end();
    process.exit(1);
  });
