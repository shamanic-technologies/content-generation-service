const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "http://localhost:3001";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;

export interface CallerContext {
  callerMethod: string;
  callerPath: string;
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
}

export interface DecryptResult {
  key: string;
  keySource: "platform" | "org";
}

function buildHeaders(
  orgId: string,
  userId: string,
  caller: CallerContext
): Record<string, string> {
  const h: Record<string, string> = {
    ...(KEY_SERVICE_API_KEY ? { "X-Api-Key": KEY_SERVICE_API_KEY } : {}),
    "x-org-id": orgId,
    "x-user-id": userId,
    "X-Caller-Service": "content-generation",
    "X-Caller-Method": caller.callerMethod,
    "X-Caller-Path": caller.callerPath,
  };
  if (caller.campaignId) h["x-campaign-id"] = caller.campaignId;
  if (caller.brandId) h["x-brand-id"] = caller.brandId;
  if (caller.workflowName) h["x-workflow-name"] = caller.workflowName;
  return h;
}

/**
 * Decrypt an API key from key-service.
 * Resolves the key for the given provider using org/user context (via headers).
 * Returns the key and its source ("platform" or "org").
 */
export async function decryptKey(
  provider: string,
  orgId: string,
  userId: string,
  caller: CallerContext
): Promise<DecryptResult> {
  const response = await fetch(
    `${KEY_SERVICE_URL}/keys/${provider}/decrypt`,
    { headers: buildHeaders(orgId, userId, caller) }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`${provider} key not configured for this organization`);
    }
    const error = await response.text();
    throw new Error(`Failed to fetch ${provider} key: ${error}`);
  }

  const data = await response.json();
  return { key: data.key, keySource: data.keySource };
}
