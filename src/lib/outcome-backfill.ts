/**
 * Backfill of the outcomes of PAST writing runs (COST-BACKFILL-1023-CONTENTGEN, owner 2026-10-23:
 * « chaque service peut rétro-engineerer pour estimer tous les coûts du passé pour être à 100 % now »).
 *
 * Since COST-ACCOUNTING-1023-P1 every email declares `message_written` on its own run, and the
 * completion that wrote it is that run's child. Before P1 the shape was different, read from the
 * run tree, never guessed:
 *
 * - the caller's run was workflow-service's `execute-workflow` run (x-run-id): the completion that
 *   wrote the email (chat-service `complete`), the brand-intel extraction and the landing-page
 *   scrape that fed it all ran as its direct children, and our `single-generation` run was opened
 *   AFTER the completion, as a cost-less sibling. So the declaration goes on that workflow run, the
 *   parent of our run: its spend that no child declares (the completion, the brand intel, the
 *   scrape) lands on the email; children that declare their own outcome (the lead serve, the sends)
 *   keep theirs. Agreed with workflow-service (2026-10-23): it declares nothing on cold-email
 *   workflow runs. Several emails written in one workflow run = several occurrences, equal split.
 * - a generation run with no parent (Feb-Mar 2026, when the service paid Anthropic itself on its
 *   own run) is declared on its own run when that run spent.
 *
 * What is declared is P1's declaration (`messageWrittenDeclaration`). No lead id = unreadable,
 * never an invented subject. Pure: the I/O is `src/bin/backfill-generation-outcomes.ts`.
 */
import { messageWrittenDeclaration, type OutcomeDeclaration, type OutcomeOccurrence } from "./run-outcomes.js";

export const CHAT_SERVICE = "chat-service";
export const COMPLETION_TASK = "complete";
export const WORKFLOW_SERVICE = "workflow";
export const WORKFLOW_TASK = "execute-workflow";

/** Products retired before the ledger: their spend stays "produced none" (owner no-go). */
export function isRetiredFeature(featureSlug: string | null | undefined): boolean {
  return !!featureSlug && featureSlug.startsWith("pr-");
}

export interface BackfillCost {
  costName: string;
  quantity: string | number;
  totalCostInUsdCents: string | number;
  status?: string | null;
}

export interface BackfillRun {
  id: string;
  parentRunId: string | null;
  serviceName: string;
  taskName: string;
  startedAt: string;
  costs: BackfillCost[];
}

export interface BackfillRow {
  id: string;
  leadId: string | null;
  featureSlug: string | null;
  variables: Record<string, unknown> | null;
}

export type BackfillDecision =
  | { kind: "declare"; runId: string; declaration: OutcomeDeclaration; via: "workflow_run" | "own_run" }
  | { kind: "unreadable"; reason: string }
  | { kind: "skipped"; reason: string };

/** Actual + refunded money of one run, in cents (reporting only; runs-service holds the truth). */
export function spentCents(run: Pick<BackfillRun, "costs">): number {
  return run.costs
    .filter((c) => c.status == null || c.status === "actual" || c.status === "refunded")
    .reduce((s, c) => s + Number(c.totalCostInUsdCents), 0);
}

/**
 * Where (if anywhere) one past email's declaration goes. `generationRun` = our run of the row,
 * `parent` = its parent run when readable.
 */
export function decideBackfill(row: BackfillRow, generationRun: BackfillRun, parent: BackfillRun | undefined): BackfillDecision {
  if (isRetiredFeature(row.featureSlug)) return { kind: "skipped", reason: `retired product (${row.featureSlug})` };
  const declaration = messageWrittenDeclaration({ leadId: row.leadId, variables: row.variables });
  if (!declaration) return { kind: "unreadable", reason: "no lead id stored on the email" };

  if (!generationRun.parentRunId) {
    if (spentCents(generationRun) > 0) return { kind: "declare", runId: generationRun.id, declaration, via: "own_run" };
    return { kind: "unreadable", reason: "no parent run and no spend on our run" };
  }
  if (!parent) return { kind: "unreadable", reason: "parent run not readable under the email's org" };
  if (parent.serviceName !== WORKFLOW_SERVICE || parent.taskName !== WORKFLOW_TASK) {
    return { kind: "unreadable", reason: `parent run is ${parent.serviceName}/${parent.taskName}, not a workflow run` };
  }
  return { kind: "declare", runId: parent.id, declaration, via: "workflow_run" };
}

export interface BatchRunEntry extends OutcomeDeclaration {
  runId: string;
  occurredAt: "run_started_at";
}

const occurrenceKey = (o: OutcomeOccurrence) => `${o.outcomeKey}|${o.subjectService}|${o.subjectId}`;

/**
 * One entry per run: the door refuses a run stated twice in one call, and a run can carry several
 * emails' declarations. The same occurrence twice (one person written twice in one run) counts once.
 */
export function mergeByRun(items: Array<{ runId: string; declaration: OutcomeDeclaration }>): BatchRunEntry[] {
  const byRun = new Map<string, { produced: Map<string, OutcomeOccurrence>; consumed: Map<string, OutcomeOccurrence> }>();
  for (const { runId, declaration } of items) {
    const e = byRun.get(runId) ?? { produced: new Map(), consumed: new Map() };
    for (const o of declaration.produced) e.produced.set(occurrenceKey(o), o);
    for (const o of declaration.consumed) e.consumed.set(occurrenceKey(o), o);
    byRun.set(runId, e);
  }
  return [...byRun].map(([runId, e]) => ({
    runId,
    occurredAt: "run_started_at" as const,
    produced: [...e.produced.values()],
    consumed: [...e.consumed.values()],
  }));
}

/** Packs entries into batches the backfill door accepts (≤ maxRuns runs, ≤ maxOccurrences occurrences). */
export function packBatches(entries: BatchRunEntry[], maxRuns = 500, maxOccurrences = 1000): BatchRunEntry[][] {
  const batches: BatchRunEntry[][] = [];
  let current: BatchRunEntry[] = [];
  let occurrences = 0;
  for (const e of entries) {
    const n = e.produced.length + e.consumed.length;
    if (n > maxOccurrences) throw new Error(`run ${e.runId} states ${n} occurrences, over the door's ${maxOccurrences}`);
    if (current.length > 0 && (current.length >= maxRuns || occurrences + n > maxOccurrences)) {
      batches.push(current);
      current = [];
      occurrences = 0;
    }
    current.push(e);
    occurrences += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
