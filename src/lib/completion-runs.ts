/**
 * Which runs-service run(s) hold the LLM cost of WRITING a stored generation (MODEL-RUN-COST-1024-CG).
 *
 * features-service prices one email-writing run per model from runs-service by run id, and only this
 * service knows which completion wrote each sequence. chat-service's `/complete` answer names no run,
 * so the completion is found in the run tree, by the output tokens it was billed for (the `actual`
 * `*-tokens-output` cost row), which this service stored on the row:
 *
 * - since COST-ACCOUNTING-1023-P1 (2026-10-24) our run is opened before the completion and sent as its
 *   `x-run-id`: the writing completion(s) are the chat-service `complete` CHILDREN of our run. A
 *   regenerated answer (MAX_GENERATION_ATTEMPTS) is two children whose output tokens add up to the
 *   stored count, so both are served.
 * - Feb-Mar 2026 the service paid the vendor on its OWN run: that run is the completion.
 * - in between, our run was opened AFTER the completion, as a cost-less sibling under the caller's
 *   workflow run, next to other completions (brand intel). The completion is the ONE sibling
 *   `complete` run billed exactly the stored output tokens (prod 2026-10-24: 2,802 of 2,806 sampled
 *   matched exactly one). None or several = cannot be told, said so, never guessed.
 *
 * Provisioned / cancelled cost rows are holds, never what the completion wrote. Pure: the I/O is
 * src/lib/completion-run-sweep.ts.
 */

export const COMPLETION_SERVICE = "chat-service";
export const COMPLETION_TASK = "complete";

export interface TreeCost {
  costName: string;
  quantity: string | number;
  status?: string | null;
}

export interface TreeRun {
  id: string;
  parentRunId: string | null;
  serviceName: string;
  taskName: string;
  costs: TreeCost[];
}

export type CompletionMatch =
  | { kind: "matched"; runIds: string[]; via: "child" | "own_run" | "sibling" }
  | { kind: "unmatched"; reason: string };

export function isCompletionRun(run: Pick<TreeRun, "serviceName" | "taskName">): boolean {
  return run.serviceName === COMPLETION_SERVICE && run.taskName === COMPLETION_TASK;
}

/** Output tokens a run was billed for (actual rows only). */
export function actualOutputTokens(run: Pick<TreeRun, "costs">): number {
  return run.costs
    .filter((c) => c.status === "actual" && c.costName.endsWith("-tokens-output"))
    .reduce((s, c) => s + Number(c.quantity), 0);
}

/**
 * `generationRun` = our run of the row with its costs; `children` = its direct chat-service
 * `complete` children with costs; `siblings` = the `complete` children of its parent with costs
 * (undefined when it has no parent, or when it was not needed).
 */
export function matchCompletionRuns(input: {
  tokensOutput: number | null;
  generationRun: TreeRun;
  children: TreeRun[];
  siblings?: TreeRun[];
}): CompletionMatch {
  const t = input.tokensOutput;
  if (t == null) return { kind: "unmatched", reason: "no output token count recorded on the generation" };

  const children = input.children.filter(isCompletionRun);
  if (children.length > 0) {
    const sum = children.reduce((s, r) => s + actualOutputTokens(r), 0);
    if (sum === t) return { kind: "matched", runIds: children.map((r) => r.id), via: "child" };
    return {
      kind: "unmatched",
      reason: `the ${children.length} completion(s) under our run were billed ${sum} output tokens, the generation recorded ${t}`,
    };
  }

  const own = actualOutputTokens(input.generationRun);
  if (own > 0) {
    if (own === t) return { kind: "matched", runIds: [input.generationRun.id], via: "own_run" };
    return { kind: "unmatched", reason: `our run was billed ${own} output tokens, the generation recorded ${t}` };
  }

  if (!input.generationRun.parentRunId) return { kind: "unmatched", reason: "our run has no parent and no completion under it" };
  const siblings = (input.siblings ?? []).filter((r) => isCompletionRun(r) && r.id !== input.generationRun.id);
  const matching = siblings.filter((r) => actualOutputTokens(r) === t);
  if (matching.length === 1) return { kind: "matched", runIds: [matching[0].id], via: "sibling" };
  if (matching.length > 1) {
    return { kind: "unmatched", reason: `${matching.length} completions beside our run were billed exactly ${t} output tokens: cannot tell which wrote it` };
  }
  return {
    kind: "unmatched",
    reason: `none of the ${siblings.length} completion(s) beside our run was billed exactly ${t} output tokens`,
  };
}
