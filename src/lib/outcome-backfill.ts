/**
 * Backfill of the outcomes of PAST writing runs (COST-BACKFILL-1023-CONTENTGEN, owner 2026-10-23:
 * « chaque service peut rétro-engineerer pour estimer tous les coûts du passé pour être à 100 % now »).
 *
 * Since COST-ACCOUNTING-1023-P1 every email declares `message_written` on its own run, and the
 * completion that wrote it is that run's child. Before P1 the shape was different, and this module
 * reads it from the run tree, never guesses:
 *
 * - the completion ran under the CALLER's run (chat-service `complete`, x-run-id = the workflow
 *   run), and our `single-generation` run was opened AFTER it as a SIBLING with no cost. So the
 *   email's spend sits on that completion run, and the declaration goes ON it: the run that paid.
 *   The completion run is the chat-service `complete` direct child of our run's parent, started
 *   after the previous generation run under that parent and before ours, whose ACTUAL token
 *   quantities equal the tokens stored on the email row (exact). Several such runs (a regenerated
 *   answer) or no exact match = unreadable, stated in dollars, never declared.
 * - Feb-Mar 2026 the service called Anthropic itself and its own run carries the token cost: the
 *   declaration goes on our own run.
 *
 * What is declared is P1's declaration (`messageWrittenDeclaration`): one produced key per run.
 * Pure: the I/O is `src/bin/backfill-generation-outcomes.ts`.
 */
import { messageWrittenDeclaration, type OutcomeDeclaration } from "./run-outcomes.js";

export const CHAT_SERVICE = "chat-service";
export const COMPLETION_TASK = "complete";
export const GENERATION_SERVICE = "content-generation-service";
export const GENERATION_TASK = "single-generation";

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
  tokensInput: number | null;
  tokensOutput: number | null;
}

export type BackfillDecision =
  | { kind: "declare"; runId: string; cents: number; declaration: OutcomeDeclaration; via: "own_run" | "completion_run" }
  | { kind: "unreadable"; reason: string; cents: number }
  | { kind: "skipped"; reason: string; cents: number };

/** Actual + refunded money of one run, in cents (reporting only; runs-service holds the truth). */
export function spentCents(run: Pick<BackfillRun, "costs">): number {
  return run.costs
    .filter((c) => c.status == null || c.status === "actual" || c.status === "refunded")
    .reduce((s, c) => s + Number(c.totalCostInUsdCents), 0);
}

// Every token cost name chat-service has written (measured 2026-10-23): the prompt is billed as
// fresh + cached + cache-write tokens, the answer as output (or text-output) tokens.
const TOKEN_KIND: Record<"input" | "output", RegExp> = {
  input: /-tokens-(input|cached-input|cache-write-[a-z0-9]+)$/,
  output: /-tokens-(output|text-output)$/,
};

function actualTokens(run: BackfillRun, kind: "input" | "output"): number {
  return run.costs
    .filter((c) => (c.status == null || c.status === "actual") && TOKEN_KIND[kind].test(c.costName))
    .reduce((s, c) => s + Number(c.quantity), 0);
}

/**
 * Where (if anywhere) one past email's declaration goes.
 * `generationRun` = our run of the row; `siblings` = every direct child of its parent (our run included).
 */
export function decideBackfill(row: BackfillRow, generationRun: BackfillRun, siblings: BackfillRun[]): BackfillDecision {
  const ownCents = spentCents(generationRun);
  const start = Date.parse(generationRun.startedAt);
  const previousGeneration = siblings
    .filter((r) => r.id !== generationRun.id && r.serviceName === GENERATION_SERVICE && r.taskName === GENERATION_TASK)
    .map((r) => Date.parse(r.startedAt))
    .filter((t) => t < start)
    .reduce((max, t) => Math.max(max, t), Number.NEGATIVE_INFINITY);
  const completions = siblings.filter((r) => {
    const t = Date.parse(r.startedAt);
    return r.serviceName === CHAT_SERVICE && r.taskName === COMPLETION_TASK && t < start && t > previousGeneration;
  });
  const completionCents = completions.reduce((s, r) => s + spentCents(r), 0);
  const cents = ownCents + completionCents;

  if (isRetiredFeature(row.featureSlug)) return { kind: "skipped", reason: `retired product (${row.featureSlug})`, cents };
  const declaration = messageWrittenDeclaration({ leadId: row.leadId, variables: row.variables });
  if (!declaration) return { kind: "unreadable", reason: "no lead id stored on the email", cents };

  if (ownCents > 0 && completions.length === 0) {
    return { kind: "declare", runId: generationRun.id, cents: ownCents, declaration, via: "own_run" };
  }
  if (completions.length === 0) return { kind: "unreadable", reason: "no completion run found beside the generation run", cents };
  if (completions.length > 1) return { kind: "unreadable", reason: `${completions.length} completion runs (regenerated answer)`, cents };

  const [completion] = completions;
  const tin = actualTokens(completion, "input");
  const tout = actualTokens(completion, "output");
  if (tin !== (row.tokensInput ?? 0) || tout !== (row.tokensOutput ?? 0)) {
    return {
      kind: "unreadable",
      reason: `completion tokens ${tin}/${tout} != stored ${row.tokensInput ?? 0}/${row.tokensOutput ?? 0}`,
      cents,
    };
  }
  return { kind: "declare", runId: completion.id, cents: completionCents + ownCents, declaration, via: "completion_run" };
}

export interface BatchRunEntry extends OutcomeDeclaration {
  runId: string;
  occurredAt: "run_started_at";
}

/** Packs entries into batches the backfill door accepts (≤ maxRuns runs, ≤ maxOccurrences occurrences). */
export function packBatches(entries: BatchRunEntry[], maxRuns = 500, maxOccurrences = 1000): BatchRunEntry[][] {
  const batches: BatchRunEntry[][] = [];
  let current: BatchRunEntry[] = [];
  let occurrences = 0;
  for (const e of entries) {
    const n = e.produced.length + e.consumed.length;
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
