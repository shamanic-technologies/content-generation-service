/**
 * Resolves "what did we actually write to this person" for a stored generation.
 *
 * The top-level `body_text` / `body_html` columns are the RETIRED spelling: the write
 * path stopped filling them when multi-step sequences shipped (last populated row is
 * from February 2026), and the copy has lived in `sequence[].bodyText` ever since —
 * ~45,000 rows. No reader moved, so every consumer asking this service for a lead's
 * email got a subject and an empty body, and the dashboard rendered a bare row.
 *
 * The resolution happens at the READ boundary rather than by backfilling the columns:
 * it fixes every historical row at once, needs no migration, and leaves the append-only
 * bronze log untouched.
 *
 * `bodySource` is the part a consumer could not previously tell apart: copy that exists
 * (`column` / `sequence`) versus copy that genuinely does not (`none`). An empty string
 * for both is what kept this silent for seven months, so absent copy is `null` + `none`.
 *
 * Standalone leaf module (imports only the equally-standalone `text-to-html`), so it is
 * safe to read from routes and from modules that many unit suites `vi.mock`.
 */
import { textToHtml } from "./text-to-html.js";

/** Where the returned body came from. `none` = the row genuinely carries no copy. */
export type GenerationBodySource = "column" | "sequence" | "none";

export interface ResolvedGenerationBody {
  bodyText: string | null;
  bodyHtml: string | null;
  bodySource: GenerationBodySource;
}

/** The subset of a generation row this resolution reads. */
export interface BodyBearingGeneration {
  bodyText?: string | null;
  bodyHtml?: string | null;
  sequence?: unknown;
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** Steps are written in order but sorted defensively — `step` is 1-based when present. */
const stepNumber = (step: Record<string, unknown>): number =>
  typeof step.step === "number" ? step.step : Number.MAX_SAFE_INTEGER;

/**
 * The first step that carries any copy. That step is the email the recipient was sent;
 * later steps are the planned follow-ups, which the caller still gets in `sequence`.
 */
function firstStepWithCopy(sequence: unknown): { bodyText: string | null; bodyHtml: string | null } | null {
  if (!Array.isArray(sequence)) return null;

  const steps = sequence.filter(
    (s): s is Record<string, unknown> => typeof s === "object" && s !== null
  );
  if (steps.length === 0) return null;

  for (const step of [...steps].sort((a, b) => stepNumber(a) - stepNumber(b))) {
    const bodyText = nonEmpty(step.bodyText);
    const bodyHtml = nonEmpty(step.bodyHtml);
    if (bodyText || bodyHtml) return { bodyText, bodyHtml };
  }
  return null;
}

/**
 * Columns win when populated (rows written before February 2026), sequence otherwise.
 * Missing HTML is regenerated from the text with the exact generation-time conversion,
 * never a second implementation of it.
 */
export function resolveGenerationBody(generation: BodyBearingGeneration): ResolvedGenerationBody {
  const columnText = nonEmpty(generation.bodyText);
  const columnHtml = nonEmpty(generation.bodyHtml);
  if (columnText || columnHtml) {
    return {
      bodyText: columnText,
      bodyHtml: columnHtml ?? (columnText ? textToHtml(columnText) : null),
      bodySource: "column",
    };
  }

  const step = firstStepWithCopy(generation.sequence);
  if (step) {
    return {
      bodyText: step.bodyText,
      bodyHtml: step.bodyHtml ?? (step.bodyText ? textToHtml(step.bodyText) : null),
      bodySource: "sequence",
    };
  }

  return { bodyText: null, bodyHtml: null, bodySource: "none" };
}

/**
 * A generation with its body fields resolved, every other field left untouched — the
 * sequence in particular is still returned whole (lead-service forwards it as the
 * planned cadence). Purely additive for existing consumers: no field is removed and
 * the two body fields only ever go from empty to populated.
 */
export function withResolvedBody<T extends BodyBearingGeneration>(
  generation: T
): T & ResolvedGenerationBody {
  return { ...generation, ...resolveGenerationBody(generation) };
}
