const STORAGE_SERVICE_URL = process.env.CLOUDFLARE_STORAGE_SERVICE_URL;
const STORAGE_SERVICE_API_KEY = process.env.CLOUDFLARE_STORAGE_SERVICE_API_KEY;

export interface UploadRequest {
  sourceUrl: string;
  folder?: string;
  filename?: string;
  contentType?: string;
}

export interface UploadResponse {
  id: string;
  url: string;
  size: number;
  contentType: string;
}

export interface StorageIdentity {
  orgId: string;
  userId: string;
  runId: string;
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
  featureSlug?: string;
}

export async function uploadToStorage(
  params: UploadRequest,
  identity: StorageIdentity,
): Promise<UploadResponse> {
  if (!STORAGE_SERVICE_URL || !STORAGE_SERVICE_API_KEY) {
    throw new Error("CLOUDFLARE_STORAGE_SERVICE_URL and CLOUDFLARE_STORAGE_SERVICE_API_KEY must be set");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": STORAGE_SERVICE_API_KEY,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
  };

  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.workflowName) headers["x-workflow-name"] = identity.workflowName;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;

  const response = await fetch(`${STORAGE_SERVICE_URL}/upload`, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Storage upload failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<UploadResponse>;
}
