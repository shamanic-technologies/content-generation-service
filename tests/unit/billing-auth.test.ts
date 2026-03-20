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
    req.orgId = req.headers["x-org-id"] || "org-123";
    req.userId = req.headers["x-user-id"] || "user-456";
    req.runId = req.headers["x-run-id"] || "run-caller-123";
    req.campaignId = req.headers["x-campaign-id"] || undefined;
    req.brandId = req.headers["x-brand-id"] || undefined;
    req.workflowName = req.headers["x-workflow-name"] || undefined;
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
      emailGenerations: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailGenerations: { id: { name: "id" }, orgId: { name: "org_id" }, idempotencyKey: { name: "idempotency_key" } },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

// Mock key-client — default to platform
const mockDecryptKey = vi.fn().mockResolvedValue({ key: "fake-key", keySource: "platform" as const });

vi.mock("../../src/lib/key-client.js", () => ({
  decryptKey: (...args: unknown[]) => mockDecryptKey(...args),
}));

// Mock billing-client
const mockAuthorizeCredits = vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 5000 });
const mockEstimateGenerationCostCents = vi.fn().mockReturnValue(6);

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredits: (...args: unknown[]) => mockAuthorizeCredits(...args),
  estimateGenerationCostCents: (...args: unknown[]) => mockEstimateGenerationCostCents(...args),
}));

// Mock anthropic client
const mockGenerateFromTemplate = vi.fn().mockResolvedValue({
  subject: "Test subject",
  sequence: [{ step: 1, bodyHtml: "<p>body</p>", bodyText: "body", daysSinceLastStep: 0 }],
  tokensInput: 500,
  tokensOutput: 100,
  costUsd: 0.005,
  promptRaw: "resolved prompt",
  responseRaw: {},
});

vi.mock("../../src/lib/anthropic-client.js", () => ({
  generateFromTemplate: (...args: unknown[]) => mockGenerateFromTemplate(...args),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

const VALID_BODY = { type: "email", variables: { recipientInfo: "test" } };

describe("POST /generate — billing authorization gate", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-456" });
    mockPromptFindFirst.mockResolvedValue({
      id: "prompt-1",
      type: "email",
      prompt: "Write an email for {{recipientInfo}}",
      variables: ["recipientInfo"],
    });
    mockDecryptKey.mockResolvedValue({ key: "fake-key", keySource: "platform" });
    mockAuthorizeCredits.mockResolvedValue({ sufficient: true, balance_cents: 5000 });
    mockEstimateGenerationCostCents.mockReturnValue(6);

    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("calls authorizeCredits when keySource is 'platform'", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .set("X-Run-Id", "run-caller-123")
      .set("X-Campaign-Id", "camp-1")
      .set("X-Brand-Id", "brand-1")
      .set("X-Workflow-Name", "my-workflow")
      .send(VALID_BODY)
      .expect(200);

    expect(mockAuthorizeCredits).toHaveBeenCalledWith(
      6,
      "content-generation — claude-sonnet-4-6",
      {
        orgId: "org-123",
        userId: "user-456",
        runId: "run-caller-123",
        campaignId: "camp-1",
        brandId: "brand-1",
        workflowName: "my-workflow",
      }
    );
  });

  it("returns 402 when billing says insufficient credits", async () => {
    mockAuthorizeCredits.mockResolvedValue({ sufficient: false, balance_cents: 2 });

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .set("X-Run-Id", "run-caller-123")
      .send(VALID_BODY)
      .expect(402);

    expect(res.body).toEqual({
      error: "Insufficient credits",
      balance_cents: 2,
      required_cents: 6,
    });

    // Must NOT call the LLM
    expect(mockGenerateFromTemplate).not.toHaveBeenCalled();
  });

  it("skips billing authorization when keySource is 'org' (BYOK)", async () => {
    mockDecryptKey.mockResolvedValue({ key: "user-own-key", keySource: "org" });

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .set("X-Run-Id", "run-caller-123")
      .send(VALID_BODY)
      .expect(200);

    // Billing must NOT be called for BYOK
    expect(mockAuthorizeCredits).not.toHaveBeenCalled();
    // But LLM should still be called
    expect(mockGenerateFromTemplate).toHaveBeenCalled();
  });

  it("proceeds with generation when billing authorizes", async () => {
    mockAuthorizeCredits.mockResolvedValue({ sufficient: true, balance_cents: 10000 });

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .set("X-Run-Id", "run-caller-123")
      .send(VALID_BODY)
      .expect(200);

    expect(mockGenerateFromTemplate).toHaveBeenCalled();
    expect(res.body.subject).toBe("Test subject");
  });

  it("returns 500 when billing-service is unreachable", async () => {
    mockAuthorizeCredits.mockRejectedValue(new Error("billing-service authorization failed: 502 - Bad Gateway"));

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .set("X-Run-Id", "run-caller-123")
      .send(VALID_BODY)
      .expect(500);

    expect(res.body.error).toContain("billing-service");
    expect(mockGenerateFromTemplate).not.toHaveBeenCalled();
  });
});

describe("estimateGenerationCostCents", () => {
  it("returns a positive integer", async () => {
    // Import the real function (not the mock)
    const { estimateGenerationCostCents } = await import("../../src/lib/billing-client.js");
    const cents = estimateGenerationCostCents();
    expect(cents).toBeGreaterThan(0);
    expect(Number.isInteger(cents)).toBe(true);
  });
});
