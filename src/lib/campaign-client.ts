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
  /** The single leg this campaign is bought for (features-service leg key, opaque). Null on pre-funnel rows. */
  legKey?: string | null;
}

// In-memory cache — featureInputs, featureSlug and legKey never change during a campaign's lifetime
// (campaign-service writes the leg once at birth).
const campaignCache = new Map<string, CampaignData>();

export type ServiceIdentity = Tracking;

function buildHeaders(identity: ServiceIdentity): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Api-Key": CAMPAIGN_SERVICE_API_KEY,
    ...buildTrackingHeaders(identity),
  };
}

async function getCampaign(campaignId: string, identity: ServiceIdentity): Promise<CampaignData | null> {
  const hit = campaignCache.get(campaignId);
  if (hit) return hit;

  const response = await fetch(
    `${CAMPAIGN_SERVICE_URL}/campaigns/${campaignId}`,
    { headers: buildHeaders(identity) }
  );

  if (!response.ok) {
    console.warn(`[campaign-client] Failed to fetch campaign ${campaignId}: ${response.status}`);
    return null;
  }

  const data = (await response.json()) as { campaign: CampaignData };
  campaignCache.set(campaignId, data.campaign);
  return data.campaign;
}

/**
 * Fetch featureInputs for a campaign. Results are cached in-memory
 * because featureInputs are immutable for the lifetime of a campaign.
 */
export async function getCampaignFeatureInputs(
  campaignId: string,
  identity: ServiceIdentity
): Promise<Record<string, unknown> | null> {
  const campaign = await getCampaign(campaignId, identity);
  return campaign?.featureInputs ?? null;
}

export type CampaignPipe =
  | { featureSlug: string; legKey: string }
  | { error: "campaign_states_no_leg" | "campaign_unreadable" }
  | null;

/**
 * The pipe a campaign is (channel = featureSlug x legKey), PIPE-FROM-STEP-1024. Null without a
 * campaign; never throws (an unreadable campaign is named, the caller declares no lead input).
 */
export async function getCampaignPipe(campaignId: string | null | undefined, identity: ServiceIdentity): Promise<CampaignPipe> {
  if (!campaignId) return null;
  let campaign: CampaignData | null;
  try {
    campaign = await getCampaign(campaignId, identity);
  } catch (err) {
    console.warn(`[campaign-client] campaign ${campaignId} unreadable: ${err instanceof Error ? err.message : err}`);
    return { error: "campaign_unreadable" };
  }
  if (!campaign) return { error: "campaign_unreadable" };
  if (!campaign.featureSlug || !campaign.legKey) return { error: "campaign_states_no_leg" };
  return { featureSlug: campaign.featureSlug, legKey: campaign.legKey };
}

/** Exposed for testing — clear the in-memory cache. */
export function clearCampaignCache(): void {
  campaignCache.clear();
}
