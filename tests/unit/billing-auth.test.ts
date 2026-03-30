import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock runs-client
const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-456" });
const mockUpdateRun = vi.fn().mockResolvedValue({});

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
}));

// Mock auth middleware
vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-123";
    req.userId = req.headers["x-user-id"] || "user-456";
    req.runId = req.headers["x-run-id"] || "run-caller-123";
    req.campaignId = req.headers["x-campaign-id"] || undefined;
    req.brandId = req.headers["x-brand-id"] || undefined;
    req.workflowSlug = req.headers["x-workflow-slug"] || undefined;
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

vi.mock("../../src/lib/campaign-client.js", () => ({
  getCampaignFeatureInputs: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn().mockResolvedValue(new Map()),
}));

// Mock anthropic client (now backed by chat-service)
class InsufficientCreditsError extends Error {
  status = 402;
  balance_cents: number;
  required_cents: number;
  constructor(balance_cents: number, required_cents: number) {
    super("Insufficient credits");
    this.balance_cents = balance_cents;
    this.required_cents = required_cents;
  }
}

const mockGenerateFromTemplate = vi.fn().mockResolvedValue({
  subject: "Test subject",
  sequence: [{ step: 1, bodyHtml: "<p>body</p>", bodyText: "body", daysSinceLastStep: 0 }],
  tokensInput: 500,
  tokensOutput: 100,
  model: "claude-sonnet-4-6",
  promptRaw: "resolved prompt",
  responseRaw: {},
});

vi.mock("../../src/lib/anthropic-client.js", () => ({
  generateFromTemplate: (...args: unknown[]) => mockGenerateFromTemplate(...args),
  InsufficientCreditsError,
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

const VALID_BODY = { type: "email", variables: { recipientInfo: "test" } };

describe("POST /generate — billing authorization (via chat-service)", () => {
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

    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("returns 402 when chat-service returns insufficient credits", async () => {
    mockGenerateFromTemplate.mockRejectedValueOnce(
      new InsufficientCreditsError(2, 5)
    );

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
      required_cents: 5,
    });
  });

  it("proceeds with generation when chat-service succeeds", async () => {
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

  it("passes identity to generateFromTemplate for chat-service auth", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .set("X-Run-Id", "run-caller-123")
      .set("X-Campaign-Id", "camp-1")
      .set("X-Brand-Id", "brand-1")
      .set("X-Workflow-Slug", "my-workflow")
      .send(VALID_BODY)
      .expect(200);

    expect(mockGenerateFromTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ promptTemplate: expect.any(String) }),
      expect.objectContaining({
        orgId: "org-123",
        userId: "user-456",
        runId: "run-caller-123",
        campaignId: "camp-1",
        brandId: "brand-1",
        workflowSlug: "my-workflow",
      })
    );
  });

  it("returns 500 when chat-service is unreachable", async () => {
    mockGenerateFromTemplate.mockRejectedValueOnce(new Error("chat-service /complete failed: 502 - Bad Gateway"));

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .set("X-Run-Id", "run-caller-123")
      .send(VALID_BODY)
      .expect(500);

    expect(res.body.error).toContain("chat-service");
  });
});
