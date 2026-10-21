import type { prompts } from "../db/schema.js";
import { servedStatus } from "./catalogue-status.js";
import { LEAD_CONTEXT_VARIABLES_PUBLISHED } from "./lead-context-variables.js";

/** The served shape of one stored template (`PromptResponse`), shared by every route that returns one. */
export function formatPromptResponse(row: typeof prompts.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    prompt: row.prompt,
    variables: row.variables,
    // Optional lead + organization inputs every template accepts, whether or not
    // its body declares a {{token}} for them. Published here so a caller builds
    // its variable mapping from the live contract rather than from a document.
    contextVariables: LEAD_CONTEXT_VARIABLES_PUBLISHED,
    // Staff catalogue status (src/lib/catalogue-status.ts): a NEW workflow must not name a
    // deprecated template. Read here by workflow-service's validator; never by /generate.
    ...servedStatus(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
