/**
 * Historical repair of stored generations whose sequence steps carry
 * OVER-ESCAPED line breaks (the two characters backslash + `n` instead of a real
 * newline U+000A).
 *
 * `src/lib/escaped-line-breaks.ts` fixed this at GENERATION time (#153). Rows
 * written before that fix still hold the model's raw output, and the dashboard
 * lead-detail timeline renders that stored copy — so a customer sees visible
 * backslash-n in follow-up content the prospect will receive as real paragraphs.
 * This module is the decision layer for the one-shot repair driven by
 * `scripts/repair-escaped-line-breaks.ts`. It is NOT wired into any request or
 * boot path: the data is wrong at rest and is fixed at rest, never on read.
 *
 * The conversion itself is NOT reimplemented here — `unescapeLineBreaks` (#153)
 * decides and converts, and `textToHtml` regenerates the HTML from the repaired
 * text exactly as generation time would. A repaired step is therefore
 * byte-identical to what the service produces today for the same model output.
 *
 * Leaf module: imports only the two other leaf modules, so a unit test never
 * drags in the `vi.mock`'d chat-service client (see CLAUDE.md "Gotchas").
 */
import { unescapeLineBreaks } from "./escaped-line-breaks.js";
import { textToHtml } from "./text-to-html.js";

/** True when the text carries at least one over-escaped line break. */
export function hasEscapedLineBreak(value: unknown): boolean {
  return typeof value === "string" && unescapeLineBreaks(value) !== value;
}

export interface SequenceRepair {
  /** The repaired sequence. Steps that were already clean are the original objects. */
  sequence: unknown[];
  /** How many steps were rewritten. Always ≥ 1 when a repair is returned. */
  repairedSteps: number;
}

function isStep(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Repair one stored `sequence` payload.
 *
 * Returns `null` when there is nothing to do — the value is not a step array, or
 * no step carries an over-escaped line break. A clean row is therefore never
 * written, and a second run over an already-repaired row is a no-op (idempotent).
 *
 * Throws when a step needs repair but has no string `bodyText` to regenerate
 * from: the HTML must come from the repaired text, never be patched in place, so
 * an un-regenerable step is surfaced rather than silently half-fixed.
 */
export function repairSequence(sequence: unknown): SequenceRepair | null {
  if (!Array.isArray(sequence)) return null;

  let repairedSteps = 0;
  const repaired = sequence.map((step) => {
    if (!isStep(step)) return step;
    if (!hasEscapedLineBreak(step.bodyText) && !hasEscapedLineBreak(step.bodyHtml)) return step;

    if (typeof step.bodyText !== "string") {
      throw new Error(
        `sequence step ${String(step.step ?? "?")} carries an over-escaped line break but has no string bodyText to regenerate from`
      );
    }

    repairedSteps++;
    const bodyText = unescapeLineBreaks(step.bodyText).trim();
    return { ...step, bodyText, bodyHtml: textToHtml(bodyText) };
  });

  return repairedSteps > 0 ? { sequence: repaired, repairedSteps } : null;
}
