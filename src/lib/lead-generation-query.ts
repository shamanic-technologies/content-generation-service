import { eq, and, arrayContains, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailGenerations } from "../db/schema.js";

/**
 * Scopes a by-lead generation read.
 *
 * A person can hold several generations in one org: one per brand that contacted them,
 * and — within a single brand — one per campaign that contacted them (the unique
 * `idx_emailgen_lead` on `(campaign_id, lead_id)` guarantees exactly one per campaign).
 * Each scope narrows; none is ever inferred. Both absent = the historical unscoped read.
 */
export interface LeadGenerationScope {
  orgId: string;
  leadId: string;
  brandId?: string;
  campaignId?: string;
}

/**
 * Reads the generation for one lead under the requested scope, newest-first when a scope
 * is applied. `undefined` when the scope matches nothing — which for a campaign scope is
 * the honest answer "that campaign never wrote to this person", not an error.
 *
 * The unscoped path is deliberately left byte-identical to what it was before scoping
 * existed: same single WHERE, no ordering, so existing callers see no change at all.
 */
export async function findGenerationForLead(scope: LeadGenerationScope) {
  const conditions: SQL[] = [
    eq(emailGenerations.leadId, scope.leadId),
    eq(emailGenerations.orgId, scope.orgId),
  ];
  if (scope.brandId) conditions.push(arrayContains(emailGenerations.brandIds, [scope.brandId]));
  // `campaign_id` is NOT NULL and POST /generate normalizes a missing campaign to "",
  // so an exact match is the whole story — no null handling, no coalesce.
  if (scope.campaignId) conditions.push(eq(emailGenerations.campaignId, scope.campaignId));

  if (!scope.brandId && !scope.campaignId) {
    return db.query.emailGenerations.findFirst({ where: and(...conditions) });
  }

  return db.query.emailGenerations.findFirst({
    where: and(...conditions),
    orderBy: (gens, { desc }) => [desc(gens.createdAt)],
  });
}
