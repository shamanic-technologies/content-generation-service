/**
 * HTTP client for brand-service.
 * Calls POST /orgs/brands/extract-fields to resolve brand info.
 * Brand-service reads x-brand-id from the header (CSV-separated brand UUIDs).
 * Results are cached 30 days per (brandId, fieldKey, hash(description)).
 */

const BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL || "http://localhost:3030";
const BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY || "";

export interface ServiceIdentity {
  orgId: string;
  userId: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

export interface ExtractFieldRequest {
  key: string;
  description: string;
}

export interface BrandFieldValue {
  value: string | string[] | Record<string, unknown> | null;
  byBrand: Record<string, { value: string | string[] | Record<string, unknown> | null; cached: boolean }>;
}

export interface ExtractFieldsResponse {
  brands: { brandId: string; domain: string; name: string }[];
  fields: Record<string, BrandFieldValue>;
}

function buildHeaders(identity: ServiceIdentity): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": BRAND_SERVICE_API_KEY,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
  };
  if (identity.runId) h["x-run-id"] = identity.runId;
  if (identity.campaignId) h["x-campaign-id"] = identity.campaignId;
  if (identity.brandId) h["x-brand-id"] = identity.brandId;
  if (identity.workflowSlug) h["x-workflow-slug"] = identity.workflowSlug;
  if (identity.featureSlug) h["x-feature-slug"] = identity.featureSlug;
  return h;
}

/**
 * Extract fields from brands via AI. Brand-service reads x-brand-id from the
 * header (CSV of brand UUIDs) and resolves fields across all brands.
 * Results are cached 30 days, so repeated calls are free (no LLM cost).
 */
export async function extractBrandFields(
  fields: ExtractFieldRequest[],
  identity: ServiceIdentity
): Promise<Map<string, string>> {
  if (fields.length === 0) return new Map();

  const response = await fetch(
    `${BRAND_SERVICE_URL}/orgs/brands/extract-fields`,
    {
      method: "POST",
      headers: buildHeaders(identity),
      body: JSON.stringify({ fields }),
    }
  );

  if (!response.ok) {
    console.warn(`[brand-client] Failed to extract brand fields: ${response.status}`);
    return new Map();
  }

  const data = (await response.json()) as ExtractFieldsResponse;

  const result = new Map<string, string>();
  for (const [key, field] of Object.entries(data.fields)) {
    if (field.value == null) continue;
    // Coerce to string for template substitution
    if (typeof field.value === "string") {
      result.set(key, field.value);
    } else if (Array.isArray(field.value)) {
      result.set(key, field.value.join(", "));
    } else {
      result.set(key, JSON.stringify(field.value));
    }
  }

  return result;
}
