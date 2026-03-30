import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock DB — we'll configure per-test
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockGroupBy = vi.fn();
const mockFindMany = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return { from: mockFrom };
    },
    query: {
      emailGenerations: {
        findMany: mockFindMany,
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailGenerations: {
    id: { name: "id" },
    orgId: { name: "org_id" },
    campaignId: { name: "campaign_id" },
    brandId: { name: "brand_id" },
    runId: { name: "run_id" },
    model: { name: "model" },
    idempotencyKey: { name: "idempotency_key" },
    workflowSlug: { name: "workflow_slug" },
    featureSlug: { name: "feature_slug" },
  },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-456" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

vi.mock("../../src/lib/campaign-client.js", () => ({
  getCampaignFeatureInputs: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../src/lib/anthropic-client.js", () => ({
  generateFromTemplate: vi.fn().mockResolvedValue({
    subject: "Test",
    sequence: [{ step: 1, bodyHtml: "<p>Hi</p>", bodyText: "Hi", daysSinceLastStep: 0 }],
    tokensInput: 100,
    tokensOutput: 50,
    model: "claude-sonnet-4-6",
    promptRaw: "prompt",
    responseRaw: {},
  }),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    status = 402;
    balance_cents: number;
    required_cents: number;
    constructor(balance_cents: number, required_cents: number) {
      super("Insufficient credits");
      this.balance_cents = balance_cents;
      this.required_cents = required_cents;
    }
  },
}));

// Mock dynasty client
const mockResolveWorkflow = vi.fn();
const mockResolveFeature = vi.fn();
const mockGetWorkflowDynastyMap = vi.fn();
const mockGetFeatureDynastyMap = vi.fn();

vi.mock("../../src/lib/dynasty-client.js", () => ({
  resolveWorkflowDynastySlugs: (...args: unknown[]) => mockResolveWorkflow(...args),
  resolveFeatureDynastySlugs: (...args: unknown[]) => mockResolveFeature(...args),
  getWorkflowDynastyMap: (...args: unknown[]) => mockGetWorkflowDynastyMap(...args),
  getFeatureDynastyMap: (...args: unknown[]) => mockGetFeatureDynastyMap(...args),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

const AUTH_HEADERS = {
  "X-Org-Id": "org-123",
  "X-User-Id": "user-456",
  "X-Run-Id": "run-789",
};

describe("GET /stats", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);

    // Default chain: select → from → where returns flat result
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ groupBy: mockGroupBy });
  });

  it("returns 400 when no filter is provided", async () => {
    const res = await request(app)
      .get("/stats")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one filter/i);
  });

  it("returns flat stats when no groupBy", async () => {
    mockWhere.mockResolvedValue([{ emailsGenerated: 42 }]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stats: { emailsGenerated: 42 },
    });
  });

  it("returns grouped stats when groupBy=campaignId", async () => {
    mockGroupBy.mockResolvedValue([
      { key: "camp-1", emailsGenerated: 10 },
      { key: "camp-2", emailsGenerated: 20 },
    ]);

    const res = await request(app)
      .get("/stats?orgId=org-123&groupBy=campaignId")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groups: [
        { key: "camp-1", stats: { emailsGenerated: 10 } },
        { key: "camp-2", stats: { emailsGenerated: 20 } },
      ],
    });
  });

  it("returns grouped stats when groupBy=model", async () => {
    mockGroupBy.mockResolvedValue([
      { key: "claude-sonnet-4-6", emailsGenerated: 30 },
    ]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&groupBy=model")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groups: [
        { key: "claude-sonnet-4-6", stats: { emailsGenerated: 30 } },
      ],
    });
  });

  it("supports runIds as comma-separated filter", async () => {
    mockWhere.mockResolvedValue([{ emailsGenerated: 5 }]);

    const res = await request(app)
      .get("/stats?runIds=r1,r2,r3")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stats: { emailsGenerated: 5 },
    });
  });

  it("supports brandId filter", async () => {
    mockWhere.mockResolvedValue([{ emailsGenerated: 7 }]);

    const res = await request(app)
      .get("/stats?brandId=brand-1")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stats: { emailsGenerated: 7 },
    });
  });

  it("supports multiple filters combined", async () => {
    mockWhere.mockResolvedValue([{ emailsGenerated: 3 }]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&brandId=brand-1&orgId=org-123")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stats: { emailsGenerated: 3 },
    });
  });

  it("rejects invalid groupBy value", async () => {
    const res = await request(app)
      .get("/stats?campaignId=camp-1&groupBy=invalid")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(400);
  });

  // --- workflowSlug / featureSlug exact filters ---

  it("filters by exact workflowSlug", async () => {
    mockWhere.mockResolvedValue([{ emailsGenerated: 12 }]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&workflowSlug=cold-email-v2")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stats: { emailsGenerated: 12 } });
  });

  it("filters by exact featureSlug", async () => {
    mockWhere.mockResolvedValue([{ emailsGenerated: 8 }]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&featureSlug=feat-alpha")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stats: { emailsGenerated: 8 } });
  });

  // --- workflowDynastySlug filter ---

  it("filters by workflowDynastySlug (resolved to versioned slugs)", async () => {
    mockResolveWorkflow.mockResolvedValue(["cold-email", "cold-email-v2"]);
    mockWhere.mockResolvedValue([{ emailsGenerated: 25 }]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&workflowDynastySlug=cold-email")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stats: { emailsGenerated: 25 } });
    expect(mockResolveWorkflow).toHaveBeenCalledWith("cold-email");
  });

  it("returns zero stats when workflowDynastySlug resolves to empty list", async () => {
    mockResolveWorkflow.mockResolvedValue([]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&workflowDynastySlug=nonexistent")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stats: { emailsGenerated: 0 } });
    // Should NOT hit the DB
    expect(mockSelect).not.toHaveBeenCalled();
  });

  // --- featureDynastySlug filter ---

  it("filters by featureDynastySlug (resolved to versioned slugs)", async () => {
    mockResolveFeature.mockResolvedValue(["feat-alpha", "feat-alpha-v2"]);
    mockWhere.mockResolvedValue([{ emailsGenerated: 15 }]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&featureDynastySlug=feat-alpha")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stats: { emailsGenerated: 15 } });
    expect(mockResolveFeature).toHaveBeenCalledWith("feat-alpha");
  });

  it("returns zero stats when featureDynastySlug resolves to empty list", async () => {
    mockResolveFeature.mockResolvedValue([]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&featureDynastySlug=nonexistent")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stats: { emailsGenerated: 0 } });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  // --- Dynasty slug filter combined with other filters ---

  it("combines workflowDynastySlug with other filters", async () => {
    mockResolveWorkflow.mockResolvedValue(["cold-email", "cold-email-v2"]);
    mockWhere.mockResolvedValue([{ emailsGenerated: 9 }]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&brandId=brand-1&workflowDynastySlug=cold-email")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stats: { emailsGenerated: 9 } });
  });

  // --- groupBy workflowSlug / featureSlug (exact) ---

  it("groups by workflowSlug", async () => {
    mockGroupBy.mockResolvedValue([
      { key: "cold-email", emailsGenerated: 10 },
      { key: "cold-email-v2", emailsGenerated: 5 },
    ]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&groupBy=workflowSlug")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groups: [
        { key: "cold-email", stats: { emailsGenerated: 10 } },
        { key: "cold-email-v2", stats: { emailsGenerated: 5 } },
      ],
    });
  });

  it("groups by featureSlug", async () => {
    mockGroupBy.mockResolvedValue([
      { key: "feat-alpha", emailsGenerated: 20 },
    ]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&groupBy=featureSlug")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groups: [
        { key: "feat-alpha", stats: { emailsGenerated: 20 } },
      ],
    });
  });

  // --- groupBy workflowDynastySlug ---

  it("groups by workflowDynastySlug (aggregates versioned slugs)", async () => {
    mockGetWorkflowDynastyMap.mockResolvedValue(
      new Map([
        ["cold-email", "cold-email"],
        ["cold-email-v2", "cold-email"],
        ["warm-intro", "warm-intro"],
      ]),
    );
    mockGroupBy.mockResolvedValue([
      { key: "cold-email", emailsGenerated: 10 },
      { key: "cold-email-v2", emailsGenerated: 5 },
      { key: "warm-intro", emailsGenerated: 7 },
    ]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&groupBy=workflowDynastySlug")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    const groups = res.body.groups;
    expect(groups).toHaveLength(2);
    // cold-email + cold-email-v2 = 15
    expect(groups.find((g: { key: string }) => g.key === "cold-email")).toEqual({
      key: "cold-email",
      stats: { emailsGenerated: 15 },
    });
    expect(groups.find((g: { key: string }) => g.key === "warm-intro")).toEqual({
      key: "warm-intro",
      stats: { emailsGenerated: 7 },
    });
  });

  // --- groupBy featureDynastySlug ---

  it("groups by featureDynastySlug (aggregates versioned slugs)", async () => {
    mockGetFeatureDynastyMap.mockResolvedValue(
      new Map([
        ["feat-alpha", "feat-alpha"],
        ["feat-alpha-v2", "feat-alpha"],
      ]),
    );
    mockGroupBy.mockResolvedValue([
      { key: "feat-alpha", emailsGenerated: 12 },
      { key: "feat-alpha-v2", emailsGenerated: 3 },
    ]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&groupBy=featureDynastySlug")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0]).toEqual({
      key: "feat-alpha",
      stats: { emailsGenerated: 15 },
    });
  });

  // --- Orphan slug fallback ---

  it("falls back to raw slug for orphans not in any dynasty", async () => {
    mockGetWorkflowDynastyMap.mockResolvedValue(
      new Map([
        ["cold-email", "cold-email"],
        ["cold-email-v2", "cold-email"],
      ]),
    );
    mockGroupBy.mockResolvedValue([
      { key: "cold-email", emailsGenerated: 10 },
      { key: "orphan-workflow", emailsGenerated: 3 },
    ]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&groupBy=workflowDynastySlug")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    const groups = res.body.groups;
    expect(groups).toHaveLength(2);
    // orphan-workflow should appear as its own key
    expect(groups.find((g: { key: string }) => g.key === "orphan-workflow")).toEqual({
      key: "orphan-workflow",
      stats: { emailsGenerated: 3 },
    });
  });

  // --- Empty dynasty groupBy returns empty groups when resolved to empty ---

  it("returns empty groups when workflowDynastySlug filter resolves to empty + groupBy", async () => {
    mockResolveWorkflow.mockResolvedValue([]);

    const res = await request(app)
      .get("/stats?campaignId=camp-1&workflowDynastySlug=nonexistent&groupBy=workflowDynastySlug")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [] });
  });
});
