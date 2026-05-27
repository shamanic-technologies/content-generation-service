import { db } from "../db/index.js";
import { prompts } from "../db/schema.js";
import {
  EXPERT_QUOTE_PITCH_TYPE,
  EXPERT_QUOTE_PITCH_TEMPLATE,
  EXPERT_QUOTE_PITCH_VARIABLES,
} from "./expert-quote-pitch-template.js";

// Platform-owned prompt templates. Each entry is reconciled on every boot:
// the source of truth lives in code, not in the DB row. To roll out a tuned
// variant per-org, use PUT /prompts to create a versioned slug (`<type>-vN`)
// — those rows have a different `type` and are never touched by this loop.
const PLATFORM_TEMPLATES = [
  {
    type: EXPERT_QUOTE_PITCH_TYPE,
    prompt: EXPERT_QUOTE_PITCH_TEMPLATE,
    variables: EXPERT_QUOTE_PITCH_VARIABLES,
  },
];

/**
 * Reconcile platform-owned prompt templates with the source code on every boot.
 * UPSERT semantics — overwrites prompt body, variables metadata, and updatedAt
 * whenever the source differs from the stored row. The unique constraint on
 * prompts.type guarantees a single row per platform template.
 */
export async function registerPlatformTemplates(): Promise<void> {
  for (const tpl of PLATFORM_TEMPLATES) {
    await db
      .insert(prompts)
      .values({
        orgId: null,
        type: tpl.type,
        prompt: tpl.prompt,
        variables: tpl.variables,
      })
      .onConflictDoUpdate({
        target: prompts.type,
        set: {
          prompt: tpl.prompt,
          variables: tpl.variables,
          updatedAt: new Date(),
        },
      });
    console.log(`[content-generation-service] Reconciled platform template '${tpl.type}'.`);
  }
}
