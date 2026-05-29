import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { featurePromptAssignment } from "../db/schema.js";
import { EXPERT_QUOTE_PITCH_TYPE } from "./expert-quote-pitch-template.js";
import { extractTemplateVariableNames } from "./template-vars.js";

// The terminal fallback prompt type for expert-quote-pitch generation when a
// feature has no explicit assignment. Single feature in scope today; if more
// features gain prompt editors this becomes a feature → default-type map.
export const PLATFORM_DEFAULT_PROMPT_TYPE = EXPERT_QUOTE_PITCH_TYPE;

/**
 * Resolve which prompt type a feature renders, by assignment then platform default.
 *
 * Resolution: feature assignment for `featureSlug` ▸ platform default.
 * (Callers that accept an explicit `templateType` override apply it BEFORE calling this.)
 */
export async function resolveAssignedPromptType(featureSlug?: string): Promise<string> {
  if (!featureSlug) return PLATFORM_DEFAULT_PROMPT_TYPE;

  const assignment = await db.query.featurePromptAssignment.findFirst({
    where: eq(featurePromptAssignment.featureSlug, featureSlug),
  });

  return assignment?.promptType ?? PLATFORM_DEFAULT_PROMPT_TYPE;
}

/** Thrown when a submitted prompt's {{var}} tokens diverge from the source template's declared set. */
export class PromptVariableMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptVariableMismatchError";
  }
}

/**
 * Integrity guard for prompt forks: the {{var}} tokens in `submittedPrompt` MUST
 * exactly match the source template's declared variable-name set. Any drop,
 * rename, or addition is rejected — a renamed variable would silently change the
 * generation contract callers depend on.
 *
 * Throws PromptVariableMismatchError naming the first offending variable.
 */
export function assertPromptVariablesMatch(
  submittedPrompt: string,
  sourceType: string,
  sourceVariables: Array<{ name: string; description: string }>
): void {
  const submitted = new Set(extractTemplateVariableNames(submittedPrompt));
  const declared = new Set(sourceVariables.map((v) => v.name));

  // Dropped or renamed-away: declared in source but absent from the submitted prompt.
  for (const name of declared) {
    if (!submitted.has(name)) {
      throw new PromptVariableMismatchError(
        `Template variable "{{${name}}}" is declared in source template '${sourceType}' but is missing from the submitted prompt. ` +
          `Variables must match the source exactly — no drop, rename, or addition.`
      );
    }
  }

  // Added or renamed-to: present in the submitted prompt but not declared in source.
  for (const name of submitted) {
    if (!declared.has(name)) {
      throw new PromptVariableMismatchError(
        `Template variable "{{${name}}}" in the submitted prompt is not declared in source template '${sourceType}'. ` +
          `Variables must match the source exactly — no drop, rename, or addition.`
      );
    }
  }
}
