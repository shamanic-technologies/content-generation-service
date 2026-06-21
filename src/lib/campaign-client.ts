/**
 * HTTP client for campaign-service.
 * Fetches campaign data and caches featureInputs per campaignId (they never change).
 */

import { type Tracking, buildTrackingHeaders } from "./tracking.js";

const CAMPAIGN_SERVICE_URL = process.env.CAMPAIGN_SERVICE_URL || "http://localhost:3020";
const CAMPAIGN_SERVICE_API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "";

export interface CampaignData {
  id: string;
  orgId: string;
  brandId: string | null;
  featureSlug: string | null;
  featureInputs: Record<string, unknown> | null;
}

// In-memory cache — featureInputs never change during a campaign's lifetime
const featureInputsCache = new Map<string, Record<string, unknown> | null>();

export type ServiceIdentity = Tracking;

function buildHeaders(identity: ServiceIdentity): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Api-Key": CAMPAIGN_SERVICE_API_KEY,
    ...buildTrackingHeaders(identity),
  };
}

/**
 * Fetch featureInputs for a campaign. Results are cached in-memory
 * because featureInputs are immutable for the lifetime of a campaign.
 */
export async function getCampaignFeatureInputs(
  campaignId: string,
  identity: ServiceIdentity
): Promise<Record<string, unknown> | null> {
  if (featureInputsCache.has(campaignId)) {
    return featureInputsCache.get(campaignId)!;
  }

  const response = await fetch(
    `${CAMPAIGN_SERVICE_URL}/campaigns/${campaignId}`,
    { headers: buildHeaders(identity) }
  );

  if (!response.ok) {
    console.warn(`[campaign-client] Failed to fetch campaign ${campaignId}: ${response.status}`);
    return null;
  }

  const data = (await response.json()) as { campaign: CampaignData };
  const featureInputs = data.campaign.featureInputs ?? null;
  featureInputsCache.set(campaignId, featureInputs);
  return featureInputs;
}

/** Exposed for testing — clear the in-memory cache. */
export function clearCampaignCache(): void {
  featureInputsCache.clear();
}
