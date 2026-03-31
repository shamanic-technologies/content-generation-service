import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock runs-client
const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-456" });
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

// Mock auth middleware
vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-internal-123";
    req.userId = req.headers["x-user-id"] || "user-internal-456";
    req.runId = req.headers["x-run-id"] || "run-caller-123";
    req.campaignId = req.headers["x-campaign-id"] || undefined;
    const brandIdRaw = req.headers["x-brand-id"] as string | undefined;
    if (brandIdRaw) {
      req.brandId = brandIdRaw;
      req.brandIds = brandIdRaw.split(",").map((s: string) => s.trim()).filter(Boolean);
    }
    next();
  },
}));

// Mock DB
const mockPromptFindFirst = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      prompts: {
        findFirst: (...args: unknown[]) => mockPromptFindFirst(...args),
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailGenerations: { id: { name: "id" } },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

// Mock anthropic client — capture what prompt was sent
const mockGenerateFromTemplate = vi.fn().mockResolvedValue({
  subject: "Test subject",
  sequence: [{ step: 1, bodyHtml: "<p>Body</p>", bodyText: "Body", daysSinceLastStep: 0 }],
  tokensInput: 500,
  tokensOutput: 100,
  model: "claude-sonnet-4-6",
  promptRaw: "resolved prompt",
  responseRaw: {},
});

vi.mock("../../src/lib/anthropic-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/anthropic-client.js")>();
  return {
    ...actual,
    generateFromTemplate: (...args: unknown[]) => mockGenerateFromTemplate(...args),
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
};
});

// Mock campaign-client
const mockGetCampaignFeatureInputs = vi.fn();
vi.mock("../../src/lib/campaign-client.js", () => ({
  getCampaignFeatureInputs: (...args: unknown[]) => mockGetCampaignFeatureInputs(...args),
}));

// Mock brand-client
const mockExtractBrandFields = vi.fn();
vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: (...args: unknown[]) => mockExtractBrandFields(...args),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("POST /generate — campaign context + brand enrichment", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-456" });
    mockPromptFindFirst.mockResolvedValue({
      id: "prompt-1",
      type: "cold-email",
      prompt: "Write an email for {{clientCompanyName}} targeting {{industry}} leads.\n\nRecipient: {{leadFirstName}} {{leadLastName}}",
      variables: ["clientCompanyName", "industry", "leadFirstName", "leadLastName"],
    });
    mockGetCampaignFeatureInputs.mockResolvedValue(null);
    mockExtractBrandFields.mockResolvedValue(new Map());

    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("fetches and passes campaignContext when x-campaign-id header is present", async () => {
    mockGetCampaignFeatureInputs.mockResolvedValue({
      angle: "sustainability",
      targetGeo: "US",
    });

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .set("X-Run-Id", "run-caller-123")
      .set("X-Campaign-Id", "camp-abc")
      .send({
        type: "cold-email",
        variables: {
          clientCompanyName: "Acme",
          industry: "SaaS",
          leadFirstName: "John",
          leadLastName: "Doe",
        },
      })
      .expect(200);

    // Campaign client was called with the campaign ID
    expect(mockGetCampaignFeatureInputs).toHaveBeenCalledWith(
      "camp-abc",
      expect.objectContaining({ orgId: "org-internal-123", campaignId: "camp-abc" })
    );

    // generateFromTemplate received campaignContext
    expect(mockGenerateFromTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignContext: { angle: "sustainability", targetGeo: "US" },
      }),
      expect.objectContaining({ orgId: "org-internal-123" })
    );
  });

  it("does not fetch campaign context when no campaignId", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .set("X-Run-Id", "run-caller-123")
      .send({
        type: "cold-email",
        variables: {
          clientCompanyName: "Acme",
          industry: "SaaS",
          leadFirstName: "John",
          leadLastName: "Doe",
        },
      })
      .expect(200);

    expect(mockGetCampaignFeatureInputs).not.toHaveBeenCalled();
    expect(mockGenerateFromTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ campaignContext: null }),
      expect.objectContaining({ orgId: "org-internal-123" })
    );
  });

  it("resolves unfilled template variables from Brand Service when brandId is present", async () => {
    // Template has {{industry}} but caller doesn't provide it
    mockExtractBrandFields.mockResolvedValue(new Map([["industry", "FinTech"]]));

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .set("X-Run-Id", "run-caller-123")
      .set("X-Brand-Id", "brand-xyz")
      .send({
        type: "cold-email",
        variables: {
          clientCompanyName: "Acme",
          // industry is missing — should be resolved from Brand Service
          leadFirstName: "Jane",
          leadLastName: "Smith",
        },
      })
      .expect(200);

    // Brand client was called for the unfilled "industry" variable (no brandId path param — reads from header)
    expect(mockExtractBrandFields).toHaveBeenCalledWith(
      [{ key: "industry", description: expect.stringContaining("industry") }],
      expect.objectContaining({ orgId: "org-internal-123", brandId: "brand-xyz" })
    );

    // The resolved variable should be passed to generateFromTemplate
    expect(mockGenerateFromTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: expect.objectContaining({ industry: "FinTech" }),
      }),
      expect.objectContaining({ orgId: "org-internal-123" })
    );
  });

  it("does not call Brand Service when all template variables are provided", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .set("X-Run-Id", "run-caller-123")
      .set("X-Brand-Id", "brand-xyz")
      .send({
        type: "cold-email",
        variables: {
          clientCompanyName: "Acme",
          industry: "SaaS",
          leadFirstName: "John",
          leadLastName: "Doe",
        },
      })
      .expect(200);

    // All variables filled — no Brand Service call needed
    expect(mockExtractBrandFields).not.toHaveBeenCalled();
  });

  it("does not call Brand Service when brandId is missing", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .set("X-Run-Id", "run-caller-123")
      .send({
        type: "cold-email",
        variables: {
          clientCompanyName: "Acme",
          leadFirstName: "John",
          leadLastName: "Doe",
          // industry is missing but no brandId → can't resolve
        },
      })
      .expect(200);

    expect(mockExtractBrandFields).not.toHaveBeenCalled();
  });

  it("fails with 502 when campaign-service is unreachable", async () => {
    mockGetCampaignFeatureInputs.mockRejectedValue(new Error("network error"));

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .set("X-Run-Id", "run-caller-123")
      .set("X-Campaign-Id", "camp-abc")
      .send({
        type: "cold-email",
        variables: {
          clientCompanyName: "Acme",
          industry: "SaaS",
          leadFirstName: "John",
          leadLastName: "Doe",
        },
      })
      .expect(500);

    // Should NOT have proceeded to generation
    expect(mockGenerateFromTemplate).not.toHaveBeenCalled();
  });

  it("proceeds gracefully when brand-service fails", async () => {
    mockExtractBrandFields.mockRejectedValue(new Error("brand service down"));

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .set("X-Run-Id", "run-caller-123")
      .set("X-Brand-Id", "brand-xyz")
      .send({
        type: "cold-email",
        variables: {
          clientCompanyName: "Acme",
          // industry missing, brand-service will fail
          leadFirstName: "John",
          leadLastName: "Doe",
        },
      })
      .expect(200);

    // Should still succeed with the variables as-is
    expect(mockGenerateFromTemplate).toHaveBeenCalled();
  });
});
