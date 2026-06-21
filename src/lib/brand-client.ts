/**
 * HTTP client for brand-service.
 * Calls POST /orgs/brands/extract-fields to resolve brand info.
 * Brand-service reads x-brand-id from the header (CSV-separated brand UUIDs).
 * Results are cached 30 days per (brandId, fieldKey, hash(description)).
 */

import { type Tracking, buildTrackingHeaders } from "./tracking.js";

const BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL || "http://localhost:3030";
const BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY || "";

export type ServiceIdentity = Tracking;

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
  return {
    "Content-Type": "application/json",
    "X-Api-Key": BRAND_SERVICE_API_KEY,
    ...buildTrackingHeaders(identity),
  };
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

/**
 * Batch-resolve brand display names by id via brand-service GET /internal/brands.
 * API-key only (no org/user identity) so it works across orgs (the global cascade tier).
 * Best-effort by design: the examples endpoint must not block on brand labels — any failure
 * returns an empty Map and the caller renders brandName as null (contract-sanctioned).
 */
export async function resolveBrandNames(brandIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(brandIds.filter(Boolean))].slice(0, 100); // /internal/brands caps at 100
  if (ids.length === 0) return new Map();

  try {
    const response = await fetch(
      `${BRAND_SERVICE_URL}/internal/brands?ids=${encodeURIComponent(ids.join(","))}`,
      { headers: { "X-Api-Key": BRAND_SERVICE_API_KEY } }
    );

    if (!response.ok) {
      console.warn(`[brand-client] resolveBrandNames failed: ${response.status}`);
      return new Map();
    }

    const data = (await response.json()) as { brands?: Array<{ id: string; name: string }> };
    return new Map((data.brands ?? []).map((b) => [b.id, b.name]));
  } catch (err) {
    console.warn(`[brand-client] resolveBrandNames error: ${(err as Error).message}`);
    return new Map();
  }
}
