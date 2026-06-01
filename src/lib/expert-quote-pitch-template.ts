// Stored prompt template for journalist-quote pitch generation (Featured.com).
// Registered at boot; consumed by POST /generate-expert-quote-pitch.
//
// Char range 100-2500 is enforced server-side after generation; we still ask the
// model to land inside that window to minimise retries.
//
// Inputs are EXPLICIT and ALL REQUIRED (see assertExpertQuotePitchVariables).
// Brand data is multibrand by default: `brands` is always an array of brand
// objects, each carrying the same required field set. Expert attribution is a
// single person. Field names mirror the features-service campaign inputs
// (`expertName` / `expertTitle` / `expertPhotoUrl` / `expertLinkedIn`, DIS-136)
// so the caller can pass them straight through with no remapping.
//
// NOTE: the public request type stays `variables: Record<string, unknown>`
// (DIS-52 — no per-field Zod schema). Required-ness is enforced at runtime here,
// not by locking the OpenAPI request shape, so callers keep JSON flexibility.

export const EXPERT_QUOTE_PITCH_TYPE = "expert-quote-pitch";

// Required sub-fields on every element of the `brands` array. These live INSIDE
// the {{brands}} token, so the top-level token scan cannot see them — they are
// validated structurally by assertExpertQuotePitchVariables.
export const EXPERT_QUOTE_PITCH_BRAND_FIELDS = [
  "brandName",
  "brandUrl",
  "brandDescription",
  "brandHeadquartersLocation",
  "brandLogoUrl",
] as const;

export const EXPERT_QUOTE_PITCH_VARIABLES = [
  {
    name: "brands",
    description:
      "JSON array of the brand(s) the expert represents. Multibrand is the default — ALWAYS an array, even for a single brand. " +
      "Each element MUST include all of: brandName, brandUrl, brandDescription (one-line bio), brandHeadquartersLocation, brandLogoUrl. " +
      "When multiple brands are provided, the model speaks as the collective.",
  },
  {
    name: "expertName",
    description:
      "Full name of the expert / spokesperson submitting the pitch — the person whose quote gets published next to the answer.",
  },
  {
    name: "expertTitle",
    description: "Title / role of the expert (e.g. 'CEO & Co-founder', 'Head of Engineering').",
  },
  {
    name: "expertBio",
    description:
      "Short bio of the expert — experience, credentials, and what makes them a credible source for this quote. Used to ground the voice.",
  },
  {
    name: "expertPhotoUrl",
    description:
      "URL of the expert's headshot (attribution asset printed beside the published quote). Context only — never echoed into the pitch body.",
  },
  {
    name: "expertLinkedIn",
    description:
      "URL of the expert's LinkedIn profile (source-verification asset). Context only — never echoed into the pitch body.",
  },
  {
    name: "journalistRequest",
    description:
      "JSON describing the journalist's request. Common fields: question (string), mediaOutlet (string|null), source (string|null — reporter name), deadline (string).",
  },
  {
    name: "expertAnswerContext",
    description:
      "Extra context the caller wants woven into the answer (angle, data points, recent work, proof). String or object — caller's choice.",
  },
];

export const EXPERT_QUOTE_PITCH_TEMPLATE = `You are responding to a journalist's request on Featured.com as the expert below. Write the quote pitch the expert will submit as their answer.

## Expert (the person whose quote gets published)
- Name: {{expertName}}
- Title / role: {{expertTitle}}
- Bio: {{expertBio}}
- Headshot URL: {{expertPhotoUrl}}
- LinkedIn: {{expertLinkedIn}}

## Brand(s) the expert represents
{{brands}}

## Journalist request
{{journalistRequest}}

## Additional answer context
{{expertAnswerContext}}

## Task
Write the pitch the expert will submit as their answer. The pitch must:
- Address the journalist's question directly with a concrete, opinionated take.
- Sound like {{expertName}} speaking — match the expert's bio, role, and the brand voice above.
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
 * Enforce the explicit, all-required input contract for the expert-quote-pitch
 * template. Two layers:
 *   1. Every variable declared in `declaredVariables` must be present + non-empty
 *      (driven by the template's own metadata, so org forks with the same set are
 *      covered automatically).
 *   2. When `brands` is a declared variable, it must be a non-empty array and each
 *      element must carry all EXPERT_QUOTE_PITCH_BRAND_FIELDS non-empty — the
 *      nested fields the top-level token scan cannot see.
 *
 * Throws ExpertQuotePitchInputError naming the first offending field.
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

  if (!declaredVariables.some((v) => v.name === "brands")) return;

  const brands = variables.brands;
  if (!Array.isArray(brands) || brands.length === 0) {
    throw new ExpertQuotePitchInputError(
      `Required variable "brands" must be a non-empty array of brand objects (${EXPERT_QUOTE_PITCH_BRAND_FIELDS.join(", ")}).`
    );
  }
  brands.forEach((brand, i) => {
    if (brand === null || typeof brand !== "object" || Array.isArray(brand)) {
      throw new ExpertQuotePitchInputError(
        `brands[${i}] must be an object with ${EXPERT_QUOTE_PITCH_BRAND_FIELDS.join(", ")}.`
      );
    }
    for (const field of EXPERT_QUOTE_PITCH_BRAND_FIELDS) {
      if (!isProvided((brand as Record<string, unknown>)[field])) {
        throw new ExpertQuotePitchInputError(`brands[${i}].${field} is required and must be non-empty.`);
      }
    }
  });
}
