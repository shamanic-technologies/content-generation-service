import { sql } from "../db/index.js";
import { mergeByRun, packBatches, type BatchRunEntry } from "../lib/outcome-backfill.js";
import { cursorAfter, readSiblingCandidates, type GenerationCursor, type UnhandledGeneration } from "../lib/outcome-backfill-query.js";
import {
  OWN_SERVICES,
  SIBLING_MARK_PREFIX,
  siblingDeclaration,
  writerSubjectFromSiblings,
  type SiblingConsumption,
  type SiblingDecision,
  type TreeRun,
} from "../lib/sibling-writer-subject.js";

/**
 * One-shot pass (LEDGER-RESIDUAL-1025-SIBLINGS, runs-service's ruling 2026-10-25): every past email
 * the backfills left undeclared, whose writer run W is the ONLY run of ours under its parent P and
 * whose sibling sends consumed `message_written` on exactly ONE lead, is declared `message_written`
 * PRODUCED on that lead, on W, dated at W's start (`occurredAt: "run_started_at"`). Rules:
 * src/lib/sibling-writer-subject.ts.
 *
 * A writer marked support (`retired_product`) whose email the sends consumed was production: its
 * mark is undone through runs-service's owner door first, with the reason, then it declares (its own
 * spend, when it has any, now rides the email).
 *
 * Dry-run by default (counts per decision, and how many marks would be undone); `--apply` writes.
 * Runs inside the container: `node dist/bin/declare-writers-from-sibling-sends.js [--apply]`.
 * Each decided row is marked (declared, or `outcomes_error = "backfill: siblings: <why> (was: …)"`)
 * and never read again: a replay reads nothing and records nothing.
 */

const RUNS_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_KEY = process.env.RUNS_SERVICE_API_KEY || "";
const SERVICE = "content-generation-service";
const CHUNK = 200;
const CONCURRENCY = 4;
const UNMARK_REASON =
  "LEDGER-RESIDUAL-1025-SIBLINGS: this writer's email was consumed by its sibling sends (instantly-service message_written), so its run was production, not support; runs-service ruling 2026-10-25.";

async function runs(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${RUNS_URL}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", "X-API-Key": RUNS_KEY, ...init.headers },
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status >= 500 && attempt < 4) throw new Error(`runs-service ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res;
    } catch (err) {
      if (attempt >= 4) throw err;
      console.error(`[siblings] retry ${attempt} ${path.slice(0, 120)}:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`runs-service ${what} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** The `message_written` consumptions declared on these runs (paged, ≤ 500 runs a call). */
async function consumptionsOf(runIds: string[]): Promise<SiblingConsumption[]> {
  const out: SiblingConsumption[] = [];
  // Never an empty runIds: the door would then serve every consumption of the key.
  if (runIds.length === 0) return out;
  for (let i = 0; i < runIds.length; i += 500) {
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ runIds: runIds.slice(i, i + 500).join(","), direction: "consumed", outcomeKey: "message_written", limit: "1000" });
      if (cursor) q.set("cursor", cursor);
      const body: { occurrences: SiblingConsumption[]; nextCursor: string | null } = await json(await runs(`/internal/outcome-occurrences?${q}`), "GET /internal/outcome-occurrences");
      out.push(...body.occurrences);
      cursor = body.nextCursor;
    } while (cursor);
  }
  return out;
}

async function decide(row: UnhandledGeneration): Promise<SiblingDecision & { writerService?: string }> {
  const w = row.generation_run_id;
  // GET /v1/runs/:id reads the run by id (x-org-id is required, not a scope): our writer has no children.
  const res = await runs(`/v1/runs/${w}`, { headers: { "x-org-id": row.org_id } });
  if (res.status === 404) return { kind: "skip", reason: "writer run gone" };
  const run = await json<{ organizationId: string | null; parentRunId: string | null; serviceName: string }>(res, `GET /v1/runs/${w}`);
  if (!run.parentRunId) return { kind: "skip", reason: "writer run has no parent" };
  if (!run.organizationId) return { kind: "skip", reason: "writer run has no org" };
  const org = { "x-org-id": run.organizationId };
  const p = encodeURIComponent(run.parentRunId);
  // Cheap gate first: a campaign's root holds thousands of children and many writers.
  let writerCount = 0;
  for (const name of OWN_SERVICES) {
    const page = await json<{ runs: TreeRun[] }>(await runs(`/v1/runs?parentRunId=${p}&serviceName=${name}&limit=2`, { headers: org }), "GET /v1/runs writers");
    writerCount += page.runs.length;
  }
  if (writerCount !== 1) return { kind: "skip", reason: `parent holds ${writerCount > 1 ? "2+" : writerCount} writers` };
  // P's children across orgs: in Feb-Mar 2026 the sends of one email sit under another org id than
  // our writer (per-service org ids of that time), and GET /v1/runs?parentRunId= is org-scoped. GET
  // /v1/runs/:id serves the whole tree; the writer count is taken again on it (the gate above saw one org).
  const tree = await json<{ descendantRuns: Array<TreeRun & { parentRunId: string | null }> }>(await runs(`/v1/runs/${p}`, { headers: org }), "GET /v1/runs/:parent");
  const children = tree.descendantRuns.filter((d) => d.parentRunId === run.parentRunId);
  const siblings = children.filter((c) => c.id !== w).map((c) => c.id);
  const decision = writerSubjectFromSiblings(w, children, siblings.length ? await consumptionsOf(siblings) : []);
  return { ...decision, writerService: run.serviceName };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Undo the support mark of writers about to declare (owner door, idempotent: a run not marked writes nothing). */
async function unmark(runIds: string[], apply: boolean): Promise<number> {
  if (runIds.length === 0) return 0;
  const body = { runIds, reason: UNMARK_REASON, unmarkedBy: "content-generation-service LEDGER-RESIDUAL-1025-SIBLINGS" };
  const path = apply ? "/v1/platform-runs/support-marks/unmark/apply" : "/v1/platform-runs/support-marks/unmark/preview";
  const r = await json<{ unmarkedCount?: number; toUnmarkCount?: number }>(
    await runs(path, { method: "POST", headers: { "x-service-name": SERVICE }, body: JSON.stringify(body) }),
    `POST ${path}`,
  );
  return (apply ? r.unmarkedCount : r.toUnmarkCount) ?? 0;
}

async function declare(entries: BatchRunEntry[]): Promise<void> {
  for (const batch of packBatches(entries)) {
    const res = await runs("/v1/platform-runs/outcomes/batch", { method: "POST", headers: { "x-service-name": SERVICE }, body: JSON.stringify({ runs: batch }) });
    if (!res.ok) throw new Error(`runs-service outcomes/batch ${res.status}: ${(await res.text()).slice(0, 1000)}`);
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const totals = new Map<string, number>();
  const add = (k: string, n = 1) => totals.set(k, (totals.get(k) ?? 0) + n);

  let cursor: GenerationCursor | null = null;
  for (;;) {
    const rows = await readSiblingCandidates(cursor, CHUNK);
    if (rows.length === 0) break;
    cursor = cursorAfter(rows);
    const decisions = await pool(rows, CONCURRENCY, decide);

    const toDeclare: Array<{ row: UnhandledGeneration; leadId: string; writerService?: string }> = [];
    const skipped: Array<{ row: UnhandledGeneration; reason: string }> = [];
    rows.forEach((row, i) => {
      const d = decisions[i];
      if (d.kind === "declare") {
        add("declare");
        if (row.lead_id && row.lead_id !== d.leadId) add("declare: lead differs from the one stored on our row");
        toDeclare.push({ row, leadId: d.leadId, writerService: d.writerService });
      } else {
        add(`skip: ${d.reason}`);
        skipped.push({ row, reason: d.reason });
      }
    });
    // The owner door takes only runs under our current name (a run of the old name is not ours to unmark there).
    const writers = [...new Set(toDeclare.filter((t) => t.writerService === SERVICE).map((t) => t.row.generation_run_id))];
    add(apply ? "support marks undone" : "support marks to undo", await unmark(writers, apply));

    if (!apply) {
      console.log(`[siblings] dry run up to ${cursor.createdAt}: ${toDeclare.length} to declare, ${skipped.length} skipped`);
      continue;
    }
    await declare(mergeByRun(toDeclare.map((t) => ({ runId: t.row.generation_run_id, declaration: siblingDeclaration(t.leadId) }))));
    for (const t of toDeclare) {
      await sql`UPDATE email_generations SET outcomes = ${JSON.stringify(siblingDeclaration(t.leadId))}::jsonb, outcomes_declared_at = now(),
        outcomes_run_id = ${t.row.generation_run_id}, outcomes_error = NULL WHERE id = ${t.row.id}::uuid`;
    }
    for (const s of skipped) {
      const mark = `${SIBLING_MARK_PREFIX} ${s.reason} (was: ${s.row.outcomes_error ?? ""})`.slice(0, 1000);
      await sql`UPDATE email_generations SET outcomes_error = ${mark} WHERE id = ${s.row.id}::uuid`;
    }
    console.log(`[siblings] up to ${cursor.createdAt}: declared ${toDeclare.length} emails, skipped ${skipped.length}`);
  }
  console.log(`${apply ? "APPLIED" : "DRY RUN"}:`);
  for (const [k, n] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
}

main()
  .then(() => sql.end())
  .catch(async (error) => {
    console.error(error);
    await sql.end();
    process.exit(1);
  });
