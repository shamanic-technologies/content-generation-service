const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "http://localhost:3001";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;

export interface CallerContext {
  callerMethod: string;
  callerPath: string;
}

function buildHeaders(caller: CallerContext): Record<string, string> {
  return {
    ...(KEY_SERVICE_API_KEY ? { "X-Api-Key": KEY_SERVICE_API_KEY } : {}),
    "X-Caller-Service": "content-generation",
    "X-Caller-Method": caller.callerMethod,
    "X-Caller-Path": caller.callerPath,
  };
}

/**
 * Fetch a BYOK (Bring Your Own Key) key from key-service.
 */
export async function getByokKey(
  clerkOrgId: string,
  provider: string,
  caller: CallerContext
): Promise<string> {
  const response = await fetch(
    `${KEY_SERVICE_URL}/internal/keys/${provider}/decrypt?clerkOrgId=${clerkOrgId}`,
    { headers: buildHeaders(caller) }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`${provider} key not configured for this organization`);
    }
    const error = await response.text();
    throw new Error(`Failed to fetch ${provider} key: ${error}`);
  }

  const data = await response.json();
  return data.key;
}

/**
 * Fetch an app-level key from key-service.
 */
export async function getAppKey(
  appId: string,
  provider: string,
  caller: CallerContext
): Promise<string> {
  const response = await fetch(
    `${KEY_SERVICE_URL}/internal/app-keys/${provider}/decrypt?appId=${appId}`,
    { headers: buildHeaders(caller) }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`${provider} key not configured for app ${appId}`);
    }
    const error = await response.text();
    throw new Error(`Failed to fetch ${provider} app key: ${error}`);
  }

  const data = await response.json();
  return data.key;
}
