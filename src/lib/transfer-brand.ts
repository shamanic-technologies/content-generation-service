import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export interface TransferBrandParams {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
}

export interface TransferBrandResult {
  updatedTables: Array<{ tableName: string; count: number }>;
}

/**
 * Moves every row this service holds for one brand from sourceOrgId to targetOrgId.
 *
 * Table audit (2026-09-27, against the current schema):
 * - `email_generations` — the only table tied to a brand. Two row shapes belong to it:
 *   (a) solo-brand rows (`brand_ids = [sourceBrandId]`);
 *   (b) rows with NO brand tag whose `campaign_id` is a campaign of the brand (a campaign is
 *       found by its solo-brand rows in the source org). Untagged rows never moved before.
 *   Co-branded rows (several brand ids) stay put: moving one would take the other brand's
 *   history with it.
 * - `email_examples_silver` — a VIEW over `email_generations`, follows it with no write.
 * - `prompts` — `org_id` is creator traceability on globally visible templates, no brand or
 *   campaign column, so nothing ties a prompt to a brand.
 * - `feature_prompt_assignment` — feature-global, no org column.
 * - `content_generations` — deprecated, no brand or campaign column (0 rows in prod).
 *
 * Money is not touched: cost truth lives in runs-service / chat-service, not here.
 *
 * Idempotent: a second call finds no row left under sourceOrgId and no row in targetOrgId
 * still carrying sourceBrandId, so it reports 0. Both statements run in one transaction.
 */
export async function transferBrand(params: TransferBrandParams): Promise<TransferBrandResult> {
  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = params;
  const newBrandId = targetBrandId ?? sourceBrandId;

  const count = await db.transaction(async (tx) => {
    const moved = await tx.execute<{ id: string }>(sql`
      WITH brand_campaigns AS (
        SELECT DISTINCT campaign_id
        FROM email_generations
        WHERE org_id = ${sourceOrgId}
          AND brand_ids = ARRAY[${sourceBrandId}]::text[]
          AND campaign_id <> ''
      )
      UPDATE email_generations
      SET org_id = ${targetOrgId},
          brand_ids = CASE
            WHEN brand_ids = ARRAY[${sourceBrandId}]::text[] THEN ARRAY[${newBrandId}]::text[]
            ELSE brand_ids
          END
      WHERE org_id = ${sourceOrgId}
        AND (
          brand_ids = ARRAY[${sourceBrandId}]::text[]
          OR (
            (brand_ids IS NULL OR cardinality(brand_ids) = 0)
            AND campaign_id IN (SELECT campaign_id FROM brand_campaigns)
          )
        )
      RETURNING id
    `);

    // Rows already moved by an earlier call made without targetBrandId: rewrite the brand id,
    // scoped to the target org (a brand id can be claimed by several orgs, whose rows are not ours to touch).
    let rewritten = 0;
    if (targetBrandId && targetBrandId !== sourceBrandId) {
      const res = await tx.execute<{ id: string }>(sql`
        UPDATE email_generations
        SET brand_ids = ARRAY[${targetBrandId}]::text[]
        WHERE org_id = ${targetOrgId}
          AND brand_ids = ARRAY[${sourceBrandId}]::text[]
        RETURNING id
      `);
      rewritten = res.length;
    }

    return moved.length + rewritten;
  });

  return { updatedTables: [{ tableName: "email_generations", count }] };
}
