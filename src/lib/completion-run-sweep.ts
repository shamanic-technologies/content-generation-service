/**
 * Stores on each generation the completion run(s) that wrote it (MODEL-RUN-COST-1024-CG). Rules:
 * src/lib/completion-runs.ts. Persisted at rest (`completion_run_ids` / `completion_runs_reason`),
 * never derived on read: GET /internal/sequences serves them and holds an entry back until matched.
 *
 * In-process sweep, single flight: first tick ~60 s after boot, then every minute, newest rows first
 * (so a new email is matched within a minute or two) then oldest first (the history since inception),
 * each pass bounded by a time budget. A runs-service failure (5xx, network) leaves the rows unmatched
 * for the next tick, logged loud; a run absent under the row's org is a stated reason.
 */
import { sql } from "../db/index.js";
import { isCompletionRun, matchCompletionRuns, type CompletionMatch, type TreeRun } from "./completion-runs.js";

type Table = "email_generations" | "whatsapp_generations";

const RUNS_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_KEY = process.env.RUNS_SERVICE_API_KEY || "";
const FIRST_TICK_MS = 60_000;
const INTERVAL_MS = 60_000;
const TICK_BUDGET_MS = 45_000;
const BATCH = 100;
const READ_CHUNK = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PendingRow {
  id: string;
  org_id: string;
  generation_run_id: string | null;
  tokens_output: number | null;
}

interface BatchRun extends TreeRun {
  descendantRuns?: TreeRun[];
}

export class RunsReadError extends Error {}

async function runsGet<T>(path: string, orgId: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RUNS_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: { "Content-Type": "application/json", "X-API-Key": RUNS_KEY, "x-org-id": orgId },
      body: init ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new RunsReadError(`runs-service ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new RunsReadError(`runs-service ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

async function readRuns(orgId: string, ids: string[]): Promise<Map<string, BatchRun>> {
  const out = new Map<string, BatchRun>();
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const body = await runsGet<{ runs: BatchRun[] }>("/v1/runs/batch", orgId, { method: "POST", body: { runIds: ids.slice(i, i + READ_CHUNK) } });
    for (const r of body.runs) out.set(r.id, r);
  }
  return out;
}

async function completionChildrenOf(orgId: string, parentRunId: string): Promise<TreeRun[]> {
  const q = new URLSearchParams({ parentRunId, serviceName: "chat-service", taskName: "complete" });
  const list = await runsGet<{ runs: Array<{ id: string }> }>(`/v1/runs?${q}`, orgId);
  if (list.runs.length === 0) return [];
  return [...(await readRuns(orgId, list.runs.map((r) => r.id))).values()];
}

/** Matches one org's rows; a runs-service failure throws (rows stay unmatched). */
export async function matchOrgRows(orgId: string, rows: PendingRow[]): Promise<Map<string, CompletionMatch>> {
  const out = new Map<string, CompletionMatch>();
  const readable = rows.filter((r) => {
    if (!r.generation_run_id) out.set(r.id, { kind: "unmatched", reason: "no run recorded for the generation" });
    else if (!UUID.test(r.generation_run_id)) out.set(r.id, { kind: "unmatched", reason: "the generation's run id is not a runs-service id" });
    else return true;
    return false;
  });
  const genRuns = await readRuns(orgId, [...new Set(readable.map((r) => r.generation_run_id!))]);
  const siblingsByParent = new Map<string, TreeRun[]>();
  for (const row of readable) {
    const gen = genRuns.get(row.generation_run_id!);
    if (!gen) {
      out.set(row.id, { kind: "unmatched", reason: "our run is not readable under the generation's org" });
      continue;
    }
    const children = (gen.descendantRuns ?? []).filter((d) => d.parentRunId === gen.id && isCompletionRun(d));
    let siblings: TreeRun[] | undefined;
    const needsSiblings = children.length === 0 && gen.parentRunId && !gen.costs.some((c) => c.status === "actual");
    if (needsSiblings) {
      siblings = siblingsByParent.get(gen.parentRunId!);
      if (!siblings) {
        siblings = await completionChildrenOf(orgId, gen.parentRunId!);
        siblingsByParent.set(gen.parentRunId!, siblings);
      }
    }
    out.set(row.id, matchCompletionRuns({ tokensOutput: row.tokens_output, generationRun: gen, children, siblings }));
  }
  return out;
}

async function store(table: Table, id: string, m: CompletionMatch): Promise<void> {
  if (m.kind === "matched") {
    await sql`UPDATE ${sql(table)} SET completion_run_ids = string_to_array(${m.runIds.join(",")}, ',') WHERE id = ${id}`;
  } else {
    await sql`UPDATE ${sql(table)} SET completion_runs_reason = ${m.reason.slice(0, 1000)} WHERE id = ${id}`;
  }
}

/** One batch of one table; returns how many rows got a stored answer. */
export async function matchPendingBatch(table: Table, order: "newest" | "oldest", limit = BATCH): Promise<{ read: number; stored: number }> {
  const rows = await sql<PendingRow[]>`
    SELECT id::text, org_id::text AS org_id, generation_run_id, tokens_output FROM ${sql(table)}
    WHERE completion_run_ids IS NULL AND completion_runs_reason IS NULL AND lead_id IS NOT NULL
      AND created_at < now() - interval '30 seconds'
    ORDER BY created_at ${order === "newest" ? sql`DESC` : sql`ASC`} LIMIT ${limit}`;
  const byOrg = new Map<string, PendingRow[]>();
  for (const r of rows) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r]);
  let stored = 0;
  for (const [orgId, orgRows] of byOrg) {
    let matches: Map<string, CompletionMatch>;
    try {
      matches = await matchOrgRows(orgId, orgRows);
    } catch (err) {
      console.error(`[completion-runs] RUNS READ FAILED (will retry) ${table} org=${orgId} rows=${orgRows.length}:`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const [id, m] of matches) {
      await store(table, id, m);
      stored++;
    }
  }
  return { read: rows.length, stored };
}

/** Newest first then oldest first, per table, until nothing is left or the budget is spent. */
export async function sweepCompletionRuns(budgetMs = TICK_BUDGET_MS): Promise<number> {
  const until = Date.now() + budgetMs;
  let total = 0;
  for (const order of ["newest", "oldest"] as const) {
    for (const table of ["email_generations", "whatsapp_generations"] as const) {
      while (Date.now() < until) {
        const { read, stored } = await matchPendingBatch(table, order);
        total += stored;
        // Newest pass: one batch per tick is enough to keep up with live writes.
        if (read === 0 || stored === 0 || order === "newest") break;
      }
    }
  }
  return total;
}

let sweeping = false;

export function startCompletionRunSweep(): void {
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const n = await sweepCompletionRuns();
      if (n) console.log(`[completion-runs] sweep: stored ${n}`);
    } catch (err) {
      console.error("[completion-runs] sweep failed:", err instanceof Error ? err.message : err);
    } finally {
      sweeping = false;
    }
  };
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), INTERVAL_MS).unref();
  }, FIRST_TICK_MS).unref();
}
