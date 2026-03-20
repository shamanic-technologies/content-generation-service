/**
 * HTTP client for billing-service credit authorization.
 * Must be called before any paid platform operation.
 */

const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "http://localhost:3010";
const BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY || "";

export interface BillingIdentity {
  orgId: string;
  userId: string;
  runId: string;
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
}

export interface AuthorizeResult {
  sufficient: boolean;
  balance_cents: number;
}

/**
 * Request credit authorization from billing-service.
 * Returns { sufficient, balance_cents }.
 * Throws on network / unexpected errors.
 */
export async function authorizeCredits(
  requiredCents: number,
  description: string,
  identity: BillingIdentity
): Promise<AuthorizeResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": BILLING_SERVICE_API_KEY,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
  };
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.workflowName) headers["x-workflow-name"] = identity.workflowName;

  const response = await fetch(`${BILLING_SERVICE_URL}/v1/credits/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      required_cents: requiredCents,
      description,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`billing-service authorization failed: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<AuthorizeResult>;
}

/**
 * Estimate cost in USD cents for a Claude Sonnet 4.6 generation.
 * Uses max_tokens (3072) as worst-case output estimate and a conservative
 * input estimate of ~2000 tokens.
 *
 * Pricing: $3/M input tokens, $15/M output tokens.
 */
export function estimateGenerationCostCents(): number {
  const estimatedInputTokens = 2000;
  const maxOutputTokens = 3072;
  const inputCostUsd = (estimatedInputTokens / 1_000_000) * 3;
  const outputCostUsd = (maxOutputTokens / 1_000_000) * 15;
  const totalCents = (inputCostUsd + outputCostUsd) * 100;
  // Round up to nearest cent to be conservative
  return Math.ceil(totalCents);
}
