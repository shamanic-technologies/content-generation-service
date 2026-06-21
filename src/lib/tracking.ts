import type { AuthenticatedRequest } from "../middleware/auth.js";

/**
 * Single source of truth for downstream identity + tracking/attribution headers.
 *
 * ALLOWLIST-DRIVEN: to propagate a new tracking dimension to every internal
 * service, add ONE entry to TRACKING_HEADER_KEYS — every client forwards it
 * automatically. No per-client, field-by-field cherry-picking.
 *
 * EGRESS GUARDRAIL: these headers are for INTERNAL services only (runs, chat,
 * campaign, brand, key, …). They must NEVER be forwarded to a third-party
 * vendor (anthropic, gemini, apollo, external Instantly API, etc.). This
 * service makes no direct vendor calls — LLM spend is delegated to chat-service
 * — so the guardrail holds by construction. If a direct vendor client is ever
 * added here, it MUST build its request headers WITHOUT buildTrackingHeaders.
 */
export interface Tracking {
  orgId: string;
  userId: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  /** Audience attribution ID (human-service org-scoped saved filter-set, audience.id). */
  audienceId?: string;
}

/** Optional tracking field → downstream header name. Add new dimensions here only. */
const TRACKING_HEADER_KEYS: ReadonlyArray<readonly [keyof Tracking, string]> = [
  ["runId", "x-run-id"],
  ["campaignId", "x-campaign-id"],
  ["brandId", "x-brand-id"],
  ["workflowSlug", "x-workflow-slug"],
  ["featureSlug", "x-feature-slug"],
  ["audienceId", "x-audience-id"],
];

/**
 * Extract the tracking block from an authenticated request. Optional headers
 * are absent outside a campaign flow — that is expected, never an error.
 */
export function extractTracking(req: AuthenticatedRequest): Tracking {
  return {
    orgId: req.orgId!,
    userId: req.userId!,
    runId: req.runId,
    campaignId: req.campaignId,
    brandId: req.brandId,
    workflowSlug: req.workflowSlug,
    featureSlug: req.featureSlug,
    audienceId: req.audienceId,
  };
}

/**
 * Build the org/user identity + tracking headers for an INTERNAL downstream
 * call. Optional fields are emitted only when present (absent → omitted, never
 * an empty string).
 */
export function buildTrackingHeaders(t: Tracking): Record<string, string> {
  const headers: Record<string, string> = {
    "x-org-id": t.orgId,
    "x-user-id": t.userId,
  };
  for (const [key, header] of TRACKING_HEADER_KEYS) {
    const value = t[key];
    if (value) headers[header] = value as string;
  }
  return headers;
}
