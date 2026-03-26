/**
 * HTTP client for campaign-service.
 * Fetches campaign data and caches featureInputs per campaignId (they never change).
 */

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

export interface ServiceIdentity {
  orgId: string;
  userId: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
  featureSlug?: string;
}

function buildHeaders(identity: ServiceIdentity): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": CAMPAIGN_SERVICE_API_KEY,
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
