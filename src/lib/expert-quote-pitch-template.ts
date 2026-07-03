// Stored prompt template for journalist-quote pitch generation (Featured.com).
// Registered at boot; consumed by POST /generate-expert-quote-pitch.
//
// Char range 100-2500 is enforced server-side after generation; we still ask the
// model to land inside that window to minimise retries.
//
// Inputs are THREE generic JSON variables — no per-field structural contract:
//   - `expert`  : freeform JSON describing the person whose quote gets published
//                 (name, title, bio, photo, linkedin, answer angle/context, …).
//   - `brands`  : freeform JSON for the brand(s) the expert represents. Multibrand
//                 is the default — usually an array, but any shape is accepted.
//   - `journalistRequest` : freeform JSON describing the journalist's request.
//
// Each variable must be PRESENT + non-empty (see assertExpertQuotePitchVariables);
// beyond that the caller owns the shape. The blobs are rendered straight into the
// prompt (markdown-coerced) so the model reads whatever the caller provides.
//
// NOTE: the public request type stays `variables: Record<string, unknown>`
// (DIS-52 — no per-field Zod schema). Required-ness is enforced at runtime here,
// not by locking the OpenAPI request shape, so callers keep JSON flexibility.

export const EXPERT_QUOTE_PITCH_TYPE = "expert-quote-pitch";

export const EXPERT_QUOTE_PITCH_VARIABLES = [
  {
    name: "expert",
    description:
      "Freeform JSON describing the expert / spokesperson whose quote gets published next to the answer. " +
      "Typically includes name, title/role, bio, headshot URL, LinkedIn, and any answer angle / data points / proof " +
      "the expert wants woven in. Shape is caller's choice — the model reads whatever is provided. " +
      "URLs (headshot, LinkedIn) are attribution context only, never echoed into the pitch body.",
  },
  {
    name: "brands",
    description:
      "Freeform JSON for the brand(s) the expert represents. Multibrand is the default — usually an array of brand " +
      "objects, but any shape is accepted. When multiple brands are provided, the model speaks as the collective.",
  },
  {
    name: "journalistRequest",
    description:
      "Freeform JSON describing the journalist's request. Common fields: question, mediaOutlet, source (reporter name), deadline.",
  },
];

export const EXPERT_QUOTE_PITCH_TEMPLATE = `You are responding to a journalist's request on Featured.com as the expert below. Write the quote pitch the expert will submit as their answer.

## Expert (the person whose quote gets published)
{{expert}}

## Brand(s) the expert represents
{{brands}}

## Journalist request
{{journalistRequest}}

## Task
Write the pitch the expert will submit as their answer. The pitch must:
- Address the journalist's question directly with a concrete, opinionated take.
- Sound like the expert speaking — match the expert's bio, role, and the brand voice above.
- Reference the expert's specific experience, data, or examples (no generic platitudes).
- When multiple brands are provided, speak as the collective — never invent a single primary if multiple are given. Weave them naturally when each contributes a distinct perspective.
- Be between 100 and 2500 characters total. Aim for 600-1200 characters.
- Read like a quote a journalist would paste into a story.

Strict bans (these are AI-giveaway phrases — never use them):
- "As an expert in", "As a [role]", "In today's fast-paced world", "It's important to note", "It's worth noting", "In conclusion", "Furthermore", "Moreover", "delve into", "navigate the landscape", "in the realm of", "leverage", "synergy", "ultimately", "at the end of the day".

Other rules:
- No preamble, no sign-off, no "Hi [Reporter]", no "Hope this helps". Output is the pitch body only.
- Never paste the headshot URL, LinkedIn URL, brand URL, or logo URL into the pitch — those are attribution assets, not quote content.
- No markdown headings, no bullet lists unless the question explicitly calls for a list of items.
- No placeholders like [Your name], [Company], [Insert X].
- Output plain text only. No JSON, no quotes around the response, no labels.

Return ONLY the pitch text.`;

/** Thrown when the request omits a required expert-quote-pitch variable. → 400. */
export class ExpertQuotePitchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpertQuotePitchInputError";
  }
}

/** A value counts as "provided" when it is present and non-empty after coercion. */
function isProvided(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true; // number, boolean
}

/**
 * Enforce the input contract for the expert-quote-pitch template: every declared
 * variable (driven by the resolved template's own metadata, so org forks with the
 * same set are covered automatically) must be PRESENT + non-empty. The variables
 * are generic JSON blobs — no per-field structural validation beyond presence.
 *
 * Throws ExpertQuotePitchInputError naming the first offending variable.
 */
export function assertExpertQuotePitchVariables(
  variables: Record<string, unknown>,
  declaredVariables: Array<{ name: string }>
): void {
  for (const { name } of declaredVariables) {
    if (!isProvided(variables[name])) {
      throw new ExpertQuotePitchInputError(`Required variable "${name}" is missing or empty.`);
    }
  }
}
