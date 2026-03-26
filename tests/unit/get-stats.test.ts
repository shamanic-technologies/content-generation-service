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
  },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-456" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

vi.mock("../../src/lib/key-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "fake-key", keySource: "platform" as const }),
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
    promptRaw: "prompt",
    responseRaw: {},
  }),
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
});
