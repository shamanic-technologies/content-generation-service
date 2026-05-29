import { eq, like } from "drizzle-orm";
import { db } from "../db/index.js";
import { prompts } from "../db/schema.js";

/**
 * Find the next available versioned type name.
 * "cold-email" → "cold-email-v2"
 * "cold-email-v5" → "cold-email-v6"
 * If "cold-email-v2" already exists, keeps incrementing until a free slot is found.
 */
export async function findNextVersionType(sourceType: string): Promise<string> {
  const match = sourceType.match(/^(.+)-v(\d+)$/);
  const baseName = match ? match[1] : sourceType;

  const existing = await db.query.prompts.findMany({
    where: like(prompts.type, `${baseName}-v%`),
    columns: { type: true },
  });

  let maxVersion = 1; // base type counts as v1
  for (const p of existing) {
    const m = p.type.match(/-v(\d+)$/);
    if (m) {
      maxVersion = Math.max(maxVersion, parseInt(m[1], 10));
    }
  }

  return `${baseName}-v${maxVersion + 1}`;
}

export interface CreatePromptVersionParams {
  sourceType: string;
  prompt: string;
  variables: Array<{ name: string; description: string }>;
  orgId: string | null;
}

export interface PromptVersionResult {
  row: typeof prompts.$inferSelect;
  /** true when a new versioned row was inserted; false when the source was returned unchanged (identical content). */
  created: boolean;
}

/**
 * Fork a prompt into a new auto-incremented version (`<sourceType>-vN`).
 *
 * - If the source does not exist, the row is created directly under `sourceType`.
 * - If the source exists and the submitted prompt + variables are byte-identical,
 *   the source row is returned untouched (`created: false`) — no new version.
 * - Otherwise a new `<base>-vN` row is inserted and returned (`created: true`).
 *
 * The source row is never mutated.
 */
export async function createPromptVersion(
  params: CreatePromptVersionParams
): Promise<PromptVersionResult> {
  const { sourceType, prompt, variables, orgId } = params;

  const source = await db.query.prompts.findFirst({
    where: eq(prompts.type, sourceType),
  });

  // Source exists and content is identical — return it as-is (no new version).
  if (
    source &&
    source.prompt === prompt &&
    JSON.stringify(source.variables) === JSON.stringify(variables)
  ) {
    return { row: source, created: false };
  }

  const newType = source ? await findNextVersionType(sourceType) : sourceType;

  const [row] = await db
    .insert(prompts)
    .values({ orgId, type: newType, prompt, variables })
    .returning();

  return { row, created: true };
}
