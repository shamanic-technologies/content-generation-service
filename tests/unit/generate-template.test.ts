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


vi.mock("../../src/lib/campaign-client.js", () => ({
  getCampaignFeatureInputs: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn().mockResolvedValue(new Map()),
}));

// Mock anthropic client — capture what prompt was sent
const mockGenerateFromTemplate = vi.fn().mockResolvedValue({
  subject: "Test subject",
  sequence: [
    { step: 1, bodyHtml: "<p>Test body</p>", bodyText: "Test body", daysSinceLastStep: 0 },
    { step: 2, bodyHtml: "<p>Follow-up 1</p>", bodyText: "Follow-up 1", daysSinceLastStep: 3 },
    { step: 3, bodyHtml: "<p>Follow-up 2</p>", bodyText: "Follow-up 2", daysSinceLastStep: 7 },
  ],
  tokensInput: 500,
  tokensOutput: 100,
  model: "claude-sonnet-4-6",
  promptRaw: "resolved prompt",
  responseRaw: {},
});

vi.mock("../../src/lib/anthropic-client.js", () => ({
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
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("POST /generate (template-based)", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-456" });
    mockPromptFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: "org-internal-123",
      type: "email",
      prompt: "Write an email.\n\n## Recipient\n{{recipientInfo}}\n\n## Sender\n{{senderInfo}}",
      variables: ["recipientInfo", "senderInfo"],
    });

    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("looks up stored prompt and passes template + variables to generateFromTemplate", async () => {
    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        variables: {
          recipientInfo: "Name: John Doe\nCompany: Acme Corp",
          senderInfo: "Name: MyBrand\nURL: https://mybrand.com",
        },
      })
      .expect(200);

    expect(res.body.subject).toBe("Test subject");
    expect(res.body.sequence).toHaveLength(3);
    expect(res.body.sequence[0].bodyText).toBe("Test body");
    expect(res.body.id).toBe("gen-789");

    expect(mockGenerateFromTemplate).toHaveBeenCalledWith(
      {
        promptTemplate: "Write an email.\n\n## Recipient\n{{recipientInfo}}\n\n## Sender\n{{senderInfo}}",
        variables: {
          recipientInfo: "Name: John Doe\nCompany: Acme Corp",
          senderInfo: "Name: MyBrand\nURL: https://mybrand.com",
        },
        includeAiDisclaimer: false,
        campaignContext: null,
      },
      expect.objectContaining({
        orgId: "org-internal-123",
        userId: "user-internal-456",
      })
    );
  });

  it("returns 404 when no prompt found for org + type", async () => {
    mockPromptFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        variables: {},
      })
      .expect(404);

    expect(res.body.error).toContain("No prompt found");
  });

  it("returns 400 when required fields are missing", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({})
      .expect(400);
  });

  it("works with optional fields (brandId, campaignId, apolloEnrichmentId)", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        variables: { recipientInfo: "test", senderInfo: "test" },
        brandId: "brand-1",
        campaignId: "campaign-1",
        apolloEnrichmentId: "enrich-1",
      })
      .expect(200);
  });

  it("accepts array and object variable values (regression: windmill sends non-strings)", async () => {
    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        variables: {
          recipientInfo: "Name: John",
          senderInfo: "MyBrand",
          personTitles: ["Executive Director", "Program Manager"],
          searchParams: { qKeywords: "blockchain OR web3" },
          tags: ["sales", "outreach"],
        },
      })
      .expect(200);

    expect(res.body.id).toBe("gen-789");
  });
});
