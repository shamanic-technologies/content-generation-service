/**
 * The signed-out preview email: ONE cold email written for a brand and a sample
 * recipient, before any campaign or lead exists.
 *
 * It is the email we would send once the visitor pays: written with the template and
 * model of the fleet's best MATURE cold-email workflow, read at request time
 * (`preview-workflow.ts`). This module holds the rest of the identity of a preview:
 * the brand intel request used when that workflow feeds none, the audience context,
 * and the stored row's key.
 *
 * Pure leaf module (no I/O, never `vi.mock`'d).
 */
import { createHash } from "node:crypto";
import { type OfferGiveLists, giveListsFingerprint } from "./offer-give-lists.js";
import type { PreviewPlan } from "./preview-workflow.js";
import { formatQualificationChecks } from "./lead-context-variables.js";

/**
 * The brand-extract-fields request the live cold-email workflows send, used ONLY when the
 * preview's workflow feeds its template no brand intel: the call still checks the brand
 * belongs to the org, names it, and gives the per-sentence highlights their brand facts.
 * When the workflow does feed brand intel, its own node's field list is sent instead.
 */
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

/**
 * The brand-extract-fields request a preview sends for its workflow: the workflow's own
 * node's field list, else `BRAND_INTEL_FIELDS`. The one place this is decided, so the
 * warm-up (`preview-warmup.ts`) asks brand-service for exactly what the preview will read.
 */
export function previewBrandIntelFields(plan: Pick<PreviewPlan, "brandIntelFields">): ReadonlyArray<{ key: string; description: string }> {
  return plan.brandIntelFields ?? BRAND_INTEL_FIELDS;
}

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
 * The audience the sample recipient came from, handed to the model as context the
 * same way a live campaign's feature inputs are. Absent → no block at all.
 */
export function buildPreviewContext(audience?: string): Record<string, unknown> | null {
  const trimmed = audience?.trim();
  return trimmed ? { audience: trimmed } : null;
}

/**
 * The recipient company's check results as the preview's writing call receives them:
 * the `leadQualification` variable, exactly as workflow-service injects a served lead's
 * `lead.qualification` into every campaign `/generate` (`{ domain, checks: [...] }`,
 * verbatim, only when `checks` is non-empty). The recipient-context block then renders
 * it under "Checks we ran on their company", the same block and rules as a campaign
 * email. Absent or `checks: []` → null: nothing is added, the prompt is byte-identical.
 */
export function previewQualificationVariable(qualification: unknown): Record<string, unknown> | null {
  if (qualification === null || typeof qualification !== "object" || Array.isArray(qualification)) return null;
  const checks = (qualification as { checks?: unknown }).checks;
  return Array.isArray(checks) && checks.length > 0 ? (qualification as Record<string, unknown>) : null;
}

/**
 * What the model reads of the check results, as the key of "the same results": the
 * rendered lines, so a changed verdict, evidence or question writes a new email while a
 * re-run that only moves `checkedAt` / `yesProbability` is answered from storage.
 * Nothing renderable → "" and the key is byte-identical to a preview without checks.
 */
export function qualificationFingerprint(qualification: unknown): string {
  const variable = previewQualificationVariable(qualification);
  if (!variable) return "";
  const lines = formatQualificationChecks(variable);
  return lines && lines.length > 0 ? JSON.stringify(lines) : "";
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
  /** The workflow whose template + model wrote it, so a new best workflow re-writes. */
  workflowSlug: string;
  /** Part of the identity so a stored preview written under an older contract is rewritten. */
  annotationVersion: string;
  /**
   * The offer's confirmed give lists, so editing them writes a new preview. Empty →
   * not part of the key, which stays byte-identical to what it was before the lists existed.
   */
  giveLists?: OfferGiveLists | null;
  /**
   * The recipient company's check results (`qualificationFingerprint`), so changed
   * results write a new preview. None → not part of the key.
   */
  qualification?: unknown;
}): string {
  const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const r = input.recipient;
  let canonical = JSON.stringify([
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
    input.workflowSlug,
    input.annotationVersion,
  ]);
  const lists = giveListsFingerprint(input.giveLists);
  if (lists) canonical = `${canonical}${lists}`;
  const checks = qualificationFingerprint(input.qualification);
  if (checks) canonical = `${canonical}|checks:${checks}`;
  return createHash("sha256").update(canonical).digest("hex");
}
