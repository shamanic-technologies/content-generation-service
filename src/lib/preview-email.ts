/**
 * The signed-out preview email: ONE cold email written for a brand and a sample
 * recipient, before any campaign or lead exists.
 *
 * Everything here exists to make that email the product's REAL writing rather than
 * an approximation of it:
 *  - the prompt is a stored platform cold-email template, the same one live
 *    campaigns render (`PREVIEW_PROMPT_TYPE`);
 *  - the brand intel is the SAME brand-service extract-fields request the live
 *    cold-email workflows send (`BRAND_INTEL_FIELDS`, keys AND descriptions copied
 *    from the active workflow DAG's `brand-extract-fields` node) and it is passed
 *    whole as `brandExtractedFields`, exactly as the DAG passes it. Byte-equal
 *    descriptions also mean brand-service answers from its 30-day cache when the
 *    brand was already read, at no extra cost;
 *  - the recipient maps onto the variable names the live `/generate` node sends.
 *
 * Pure leaf module (no I/O, never `vi.mock`'d).
 */
import { createHash } from "node:crypto";

/**
 * Most-rendered platform cold-email template in production (890 of the last 7 days'
 * generations, 2026-09-28). Its `-landing` sibling needs the lead's scraped website,
 * which a preview does not have; this one needs only person + company + brand.
 */
export const PREVIEW_PROMPT_TYPE = "cold-email-v39";

/** Copied verbatim from the live cold-email workflow's `brand-extract-fields` node. */
export const BRAND_INTEL_FIELDS: ReadonlyArray<{ key: string; description: string }> = [
  { key: "companyOverview", description: "A comprehensive overview of the company" },
  { key: "valueProposition", description: "The company's core value proposition" },
  { key: "keyFeatures", description: "Key features of the company's product or service" },
  { key: "targetAudience", description: "The company's target audience" },
  { key: "customerPainPoints", description: "Pain points the company solves for customers" },
  { key: "competitors", description: "The company's main competitors" },
  { key: "productDifferentiators", description: "What differentiates the product from competitors" },
  { key: "socialProof", description: "Social proof such as testimonials, case studies, or notable clients" },
  { key: "callToAction", description: "The company's primary call to action" },
  { key: "urgency", description: "Any urgency or time-sensitive elements" },
  { key: "scarcity", description: "Any scarcity or limited availability elements" },
  { key: "riskReversal", description: "Guarantees or risk reversal offers" },
  { key: "valueStacking", description: "Value stacking or bundling strategies" },
  { key: "priceAnchoring", description: "Price anchoring or pricing strategies" },
  { key: "leadership", description: "Company leadership and key team members" },
  { key: "funding", description: "Funding information and investors" },
  { key: "revenueMilestones", description: "Revenue milestones and growth metrics" },
  { key: "awardsAndRecognition", description: "Awards, recognition, and press mentions" },
  { key: "additionalContext", description: "Any additional relevant context about the company" },
];

export interface PreviewRecipient {
  firstName: string;
  lastName: string;
  title: string;
  companyName: string;
  companyDomain?: string;
  headline?: string;
  companyIndustry?: string;
  companyDescription?: string;
}

/**
 * Template variables for one preview, spelled the way the live `/generate` node
 * spells them. Every token the template declares that the caller could not supply
 * is set to "" so the prompt reads "Industry: " (unknown) rather than a literal
 * `{{leadCompanyIndustry}}`; the template's own honesty floor forbids inventing it.
 * Facts the template body never asks for (the company domain) reach the model
 * through the recipient-context block, as they do for a live generation.
 */
export function buildPreviewVariables(
  recipient: PreviewRecipient,
  brandName: string,
  brandExtractedFields: unknown,
  templateTokens: readonly string[]
): Record<string, unknown> {
  const variables: Record<string, unknown> = {
    leadFirstName: recipient.firstName,
    leadLastName: recipient.lastName,
    leadTitle: recipient.title,
    leadCompanyName: recipient.companyName,
    clientName: brandName,
    brandExtractedFields,
  };
  if (recipient.headline) variables.leadHeadline = recipient.headline;
  if (recipient.companyIndustry) variables.leadCompanyIndustry = recipient.companyIndustry;
  if (recipient.companyDescription) variables.leadCompanyDescription = recipient.companyDescription;
  if (recipient.companyDomain) variables.leadCompanyWebsiteUrl = recipient.companyDomain;
  for (const token of templateTokens) {
    if (!(token in variables)) variables[token] = "";
  }
  return variables;
}

/**
 * The audience the sample recipient came from, handed to the model as context the
 * same way a live campaign's feature inputs are. Absent → no block at all.
 */
export function buildPreviewContext(audience?: string): Record<string, unknown> | null {
  const trimmed = audience?.trim();
  return trimmed ? { audience: trimmed } : null;
}

/**
 * Identity of "the same brand and recipient" for re-spend avoidance: every input
 * that changes the written email, normalized so casing and stray whitespace do not
 * count as a different person. The brand and org are the row's own columns.
 */
export function previewRecipientKey(input: {
  recipient: PreviewRecipient;
  audience?: string;
  offerId?: string;
  promptType: string;
  model: string;
}): string {
  const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const r = input.recipient;
  const canonical = JSON.stringify([
    norm(r.firstName),
    norm(r.lastName),
    norm(r.title),
    norm(r.companyName),
    norm(r.companyDomain),
    norm(r.headline),
    norm(r.companyIndustry),
    norm(r.companyDescription),
    norm(input.audience),
    norm(input.offerId),
    input.promptType,
    input.model,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
