/**
 * Gold layer (medallion) — derive-on-read cascade of example emails for a workflow.
 *
 * Reads the silver view `email_examples_silver` (content-bearing, conformed) and projects
 * a "give me N examples" business view for the dashboard workflow-picker. Parameterized by
 * caller, so it is computed at read time and NOT materialized (Lakshmanan: minimize copies,
 * keep gold small). Cascade: current brand -> same org other brands -> any org (global).
 */
import { and, eq, desc, not, arrayContains, notInArray, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailExamplesSilver } from "../db/schema.js";

export type ExampleScope = "brand" | "org" | "global";

/** A single cascade row, pre-enrichment (brandName attached later in toExampleEmail). */
export interface ExampleRow {
  id: string;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  sequence: unknown;
  leadFirstName: string | null;
  leadLastName: string | null;
  leadCompany: string | null;
  leadTitle: string | null;
  leadIndustry: string | null;
  clientCompanyName: string | null;
  createdAt: Date;
  brandIds: string[];
  scope: ExampleScope;
}

/** The dashboard-facing example shape (LOCKED contract — api-service proxies byte-equal). */
export interface ExampleEmail {
  id: string;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  sequence: unknown;
  leadFirstName: string | null;
  leadLastName: string | null;
  leadCompany: string | null;
  leadTitle: string | null;
  leadIndustry: string | null;
  clientCompanyName: string | null;
  createdAt: string;
  scope: ExampleScope;
  brandName: string | null;
}

// Built lazily inside fetchTier (NOT at module eval) so importing this module stays safe
// under unit tests that fully mock src/db/schema.js without the emailExamplesSilver export.
const silverColumns = () => ({
  id: emailExamplesSilver.id,
  subject: emailExamplesSilver.subject,
  bodyHtml: emailExamplesSilver.bodyHtml,
  bodyText: emailExamplesSilver.bodyText,
  sequence: emailExamplesSilver.sequence,
  leadFirstName: emailExamplesSilver.leadFirstName,
  leadLastName: emailExamplesSilver.leadLastName,
  leadCompany: emailExamplesSilver.leadCompany,
  leadTitle: emailExamplesSilver.leadTitle,
  leadIndustry: emailExamplesSilver.leadIndustry,
  clientCompanyName: emailExamplesSilver.clientCompanyName,
  createdAt: emailExamplesSilver.createdAt,
  brandIds: emailExamplesSilver.brandIds,
});

async function fetchTier(where: SQL, limit: number, scope: ExampleScope): Promise<ExampleRow[]> {
  if (limit <= 0) return [];
  const rows = await db
    .select(silverColumns())
    .from(emailExamplesSilver)
    .where(where)
    .orderBy(desc(emailExamplesSilver.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    brandIds: r.brandIds ?? [],
    createdAt: r.createdAt as Date,
    scope,
  }));
}

/**
 * Cascade newest-first, brand-tier first, deduped by id. Fills up to `limit`:
 *   1. brand  — caller org AND brandId in brand_ids
 *   2. org    — caller org AND brandId NOT in brand_ids (fills the remainder)
 *   3. global — any org (fills the remainder); examples are public, so no org restriction
 */
export async function fetchWorkflowExamples(params: {
  callerOrgId: string;
  brandId: string;
  workflowSlug: string;
  limit: number;
}): Promise<ExampleRow[]> {
  const { callerOrgId, brandId, workflowSlug, limit } = params;
  const slugMatch = eq(emailExamplesSilver.workflowSlug, workflowSlug);
  const inBrand = arrayContains(emailExamplesSilver.brandIds, [brandId]);

  const picked: ExampleRow[] = [];
  const excludePicked = (): SQL | undefined =>
    picked.length ? notInArray(emailExamplesSilver.id, picked.map((r) => r.id)) : undefined;

  // Tier 1 — current brand
  picked.push(
    ...(await fetchTier(
      and(slugMatch, eq(emailExamplesSilver.orgId, callerOrgId), inBrand)!,
      limit,
      "brand"
    ))
  );

  // Tier 2 — same org, other brands
  if (picked.length < limit) {
    picked.push(
      ...(await fetchTier(
        and(slugMatch, eq(emailExamplesSilver.orgId, callerOrgId), not(inBrand), excludePicked())!,
        limit - picked.length,
        "org"
      ))
    );
  }

  // Tier 3 — any org (global; examples are public)
  if (picked.length < limit) {
    picked.push(
      ...(await fetchTier(and(slugMatch, excludePicked())!, limit - picked.length, "global"))
    );
  }

  return picked.slice(0, limit);
}

/**
 * Project a cascade row to the dashboard contract, attaching the SOURCE brand's display name.
 * brandName is null for own-brand scope (the dashboard already knows it) and null when the
 * batch lookup did not return a name — both are contract-sanctioned (best-effort, never blocks).
 *
 * TODO(product): cross-org examples surface the original lead's identity un-anonymized. Product
 * decision is that this is acceptable for now (examples are public); may revisit to anonymize.
 */
export function toExampleEmail(row: ExampleRow, brandNames: Map<string, string>): ExampleEmail {
  const sourceBrandId = row.brandIds[0];
  const brandName =
    row.scope === "brand" || !sourceBrandId ? null : brandNames.get(sourceBrandId) ?? null;
  return {
    id: row.id,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    sequence: row.sequence ?? [],
    leadFirstName: row.leadFirstName,
    leadLastName: row.leadLastName,
    leadCompany: row.leadCompany,
    leadTitle: row.leadTitle,
    leadIndustry: row.leadIndustry,
    clientCompanyName: row.clientCompanyName,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    scope: row.scope,
    brandName,
  };
}
