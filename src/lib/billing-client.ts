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

export interface BillingCostItem {
  costName: string;
  quantity: number;
}

export interface AuthorizeResult {
  sufficient: boolean;
  balance_cents: number;
  required_cents: number;
}

/**
 * Request credit authorization from billing-service.
 * Sends costName + quantity items — billing-service resolves the price internally.
 * Returns { sufficient, balance_cents, required_cents }.
 * Throws on network / unexpected errors.
 */
export async function authorizeCredits(
  items: BillingCostItem[],
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
    body: JSON.stringify({ items, description }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`billing-service authorization failed: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<AuthorizeResult>;
}

/** Conservative token estimates for pre-authorization (before the LLM call). */
export const ESTIMATED_INPUT_TOKENS = 2000;
export const ESTIMATED_OUTPUT_TOKENS = 3072; // matches max_tokens
