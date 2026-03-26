/**
 * HTTP client for brand-service.
 * Calls POST /brands/{brandId}/extract-fields to resolve brand info.
 * Brand-service caches results for 30 days per (brandId, fieldKey).
 */

const BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL || "http://localhost:3030";
const BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY || "";

export interface ServiceIdentity {
  orgId: string;
  userId: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
  featureSlug?: string;
}

export interface ExtractFieldRequest {
  key: string;
  description: string;
}

export interface ExtractFieldResult {
  key: string;
  value: string | string[] | Record<string, unknown> | null;
  cached: boolean;
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
  if (identity.workflowName) h["x-workflow-name"] = identity.workflowName;
  if (identity.featureSlug) h["x-feature-slug"] = identity.featureSlug;
  return h;
}

/**
 * Extract fields from a brand via AI. Brand-service caches results for 30 days,
 * so repeated calls with the same fields are free (no LLM cost).
 */
export async function extractBrandFields(
  brandId: string,
  fields: ExtractFieldRequest[],
  identity: ServiceIdentity
): Promise<Map<string, string>> {
  if (fields.length === 0) return new Map();

  const response = await fetch(
    `${BRAND_SERVICE_URL}/brands/${brandId}/extract-fields`,
    {
      method: "POST",
      headers: buildHeaders(identity),
      body: JSON.stringify({ fields }),
    }
  );

  if (!response.ok) {
    console.warn(`[brand-client] Failed to extract fields for brand ${brandId}: ${response.status}`);
    return new Map();
  }

  const data = (await response.json()) as {
    brandId: string;
    results: ExtractFieldResult[];
  };

  const result = new Map<string, string>();
  for (const r of data.results) {
    if (r.value == null) continue;
    // Coerce to string for template substitution
    if (typeof r.value === "string") {
      result.set(r.key, r.value);
    } else if (Array.isArray(r.value)) {
      result.set(r.key, r.value.join(", "));
    } else {
      result.set(r.key, JSON.stringify(r.value));
    }
  }

  return result;
}
