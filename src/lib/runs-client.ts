/**
 * HTTP client for runs-service
 * Centralized run tracking and cost management
 */

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Run {
  id: string;
  parentRunId: string | null;
  organizationId: string;
  userId: string | null;
  brandId: string | null;
  campaignId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunCost {
  id: string;
  runId: string;
  costName: string;
  quantity: string;
  unitCostInUsdCents: string;
  totalCostInUsdCents: string;
  createdAt: string;
}

export interface DescendantRun {
  id: string;
  parentRunId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  costs: RunCost[];
  ownCostInUsdCents: string;
}

export interface RunWithCosts extends Run {
  costs: RunCost[];
  ownCostInUsdCents: string;
  childrenCostInUsdCents: string;
  totalCostInUsdCents: string;
  descendantRuns: DescendantRun[];
}

/** Identity headers forwarded on every downstream call. */
export interface IdentityHeaders {
  orgId: string;
  userId: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}

export interface CreateRunParams {
  serviceName: string;
  taskName: string;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
}

export interface CostItem {
  costName: string;
  quantity: number;
  costSource: "platform" | "org";
}

export interface ListRunsParams {
  userId?: string;
  brandId?: string;
  campaignId?: string;
  serviceName?: string;
  taskName?: string;
  status?: string;
  parentRunId?: string;
  startedAfter?: string;
  startedBefore?: string;
  limit?: number;
  offset?: number;
}

export interface RunSummaryParams {
  serviceName?: string;
  startedAfter?: string;
  startedBefore?: string;
  groupBy?: "costName" | "userId" | "serviceName";
}

export interface SummaryBreakdown {
  key: string;
  totalCostInUsdCents: string;
  totalQuantity?: string;
  runCount?: number;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

const TRANSIENT_STATUS_CODES = new Set([500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function isTransientError(status: number): boolean {
  return TRANSIENT_STATUS_CODES.has(status);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runsRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; identity?: IdentityHeaders } = {}
): Promise<T> {
  const { method = "GET", body, identity } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": RUNS_SERVICE_API_KEY,
  };

  if (identity) {
    headers["x-org-id"] = identity.orgId;
    headers["x-user-id"] = identity.userId;
    if (identity.runId) {
      headers["x-run-id"] = identity.runId;
    }
    if (identity.campaignId) {
      headers["x-campaign-id"] = identity.campaignId;
    }
    if (identity.brandId) {
      headers["x-brand-id"] = identity.brandId;
    }
    if (identity.workflowSlug) {
      headers["x-workflow-slug"] = identity.workflowSlug;
    }
    if (identity.featureSlug) {
      headers["x-feature-slug"] = identity.featureSlug;
    }
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[runs-client] Retry ${attempt}/${MAX_RETRIES} for ${method} ${path} in ${delay}ms`);
      await sleep(delay);
    }

    const response = await fetch(`${RUNS_SERVICE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.ok) {
      return response.json() as Promise<T>;
    }

    const errorText = await response.text();
    lastError = new Error(`runs-service ${method} ${path} failed: ${response.status} - ${errorText}`);

    if (!isTransientError(response.status)) {
      throw lastError;
    }
  }

  throw lastError!;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new run in runs-service.
 * Identity headers supply orgId, userId, and parentRunId (via x-run-id).
 */
export async function createRun(params: CreateRunParams, identity: IdentityHeaders): Promise<Run> {
  return runsRequest<Run>("/v1/runs", {
    method: "POST",
    body: params,
    identity,
  });
}

/**
 * Update run status (completed or failed).
 */
export async function updateRun(
  runId: string,
  status: "completed" | "failed",
  identity: IdentityHeaders
): Promise<Run> {
  return runsRequest<Run>(`/v1/runs/${runId}`, {
    method: "PATCH",
    body: { status },
    identity,
  });
}

/**
 * Add cost line items to a run.
 * Cost names must be registered in costs-service.
 */
export async function addCosts(
  runId: string,
  items: CostItem[],
  identity: IdentityHeaders
): Promise<{ costs: RunCost[] }> {
  return runsRequest<{ costs: RunCost[] }>(`/v1/runs/${runId}/costs`, {
    method: "POST",
    body: { items },
    identity,
  });
}

/**
 * Get a single run with costs (including recursive children costs).
 */
export async function getRun(runId: string, identity: IdentityHeaders): Promise<RunWithCosts> {
  return runsRequest<RunWithCosts>(`/v1/runs/${runId}`, { identity });
}

/**
 * List runs with filters.
 */
export async function listRuns(
  params: ListRunsParams,
  identity: IdentityHeaders
): Promise<{ runs: (Run & { ownCostInUsdCents: string })[]; limit: number; offset: number }> {
  const searchParams = new URLSearchParams();
  if (params.userId) searchParams.set("userId", params.userId);
  if (params.brandId) searchParams.set("brandId", params.brandId);
  if (params.campaignId) searchParams.set("campaignId", params.campaignId);
  if (params.serviceName) searchParams.set("serviceName", params.serviceName);
  if (params.taskName) searchParams.set("taskName", params.taskName);
  if (params.status) searchParams.set("status", params.status);
  if (params.parentRunId) searchParams.set("parentRunId", params.parentRunId);
  if (params.startedAfter) searchParams.set("startedAfter", params.startedAfter);
  if (params.startedBefore) searchParams.set("startedBefore", params.startedBefore);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.offset) searchParams.set("offset", String(params.offset));

  return runsRequest<{ runs: (Run & { ownCostInUsdCents: string })[]; limit: number; offset: number }>(
    `/v1/runs?${searchParams.toString()}`,
    { identity }
  );
}

/**
 * Fetch multiple runs with costs in parallel.
 * Returns a Map of runId → RunWithCosts.
 */
export async function getRunsBatch(
  runIds: string[],
  identity: IdentityHeaders
): Promise<Map<string, RunWithCosts>> {
  if (runIds.length === 0) return new Map();
  const results = await Promise.all(runIds.map((id) => getRun(id, identity)));
  return new Map(results.map((r) => [r.id, r]));
}

/**
 * Get aggregated cost summary.
 */
export async function getRunSummary(
  params: RunSummaryParams,
  identity: IdentityHeaders
): Promise<{ breakdown: SummaryBreakdown[] }> {
  const searchParams = new URLSearchParams();
  if (params.serviceName) searchParams.set("serviceName", params.serviceName);
  if (params.startedAfter) searchParams.set("startedAfter", params.startedAfter);
  if (params.startedBefore) searchParams.set("startedBefore", params.startedBefore);
  if (params.groupBy) searchParams.set("groupBy", params.groupBy);

  return runsRequest<{ breakdown: SummaryBreakdown[] }>(
    `/v1/runs/summary?${searchParams.toString()}`,
    { identity }
  );
}
