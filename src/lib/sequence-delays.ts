/**
 * Every step of a served sequence carries a numeric `daysSinceLastStep`, because
 * email-gateway `POST /orgs/send` requires one on every step and 400s the whole
 * send when any is missing (`sequence: Invalid input: expected number, received
 * undefined`). By then the run has already paid for enrichment and generation.
 *
 * Two rules, one implementation, applied wherever this service serves a sequence
 * (a fresh generation before it is stored, and every stored generation it answers
 * with — the lead-retry, idempotency and race paths):
 *
 * - STEP 1 without a delay is 0. Nothing precedes the first email, so "days since
 *   the last step" is 0 by definition — the system prompt says as much ("0 for the
 *   first") and every stored first step that carries a value carries 0. Some models
 *   (glm, deepseek) dropped it; that is an omission of a known value, not a guess.
 * - ANY LATER STEP without a finite, non-negative delay is not servable. The wait
 *   between two follow-ups is the model's decision and cannot be derived, so the
 *   sequence fails loud with `IncompleteSequenceError` naming the steps, instead of
 *   reaching the gateway incomplete.
 *
 * A sequence that already satisfies both is returned with identical values.
 * Standalone leaf (never `vi.mock`'d).
 */

export class IncompleteSequenceError extends Error {
  status = 502;
  steps: number[];

  constructor(steps: number[], generationId?: string) {
    const where = generationId ? ` (generation ${generationId})` : "";
    super(
      `Sequence${where} has no numeric daysSinceLastStep on step(s) ${steps.join(", ")} — ` +
        "cannot be sent, email-gateway requires a delay on every step"
    );
    this.name = "IncompleteSequenceError";
    this.steps = steps;
  }
}

function isDelay(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function withSequenceDelays<T extends { daysSinceLastStep?: unknown }>(
  sequence: T[],
  generationId?: string
): Array<T & { daysSinceLastStep: number }> {
  const missing: number[] = [];
  const out = sequence.map((step, i) => {
    const delay = step.daysSinceLastStep;
    if (i === 0 && (delay === undefined || delay === null)) {
      return { ...step, daysSinceLastStep: 0 };
    }
    if (!isDelay(delay)) missing.push(i + 1);
    return step as T & { daysSinceLastStep: number };
  });
  if (missing.length > 0) throw new IncompleteSequenceError(missing, generationId);
  return out;
}
