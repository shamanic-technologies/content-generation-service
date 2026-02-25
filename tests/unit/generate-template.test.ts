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
    req.orgId = "org-internal-123";
    req.clerkOrgId = req.headers["x-clerk-org-id"] || "org_test";
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
  prompts: { appId: { name: "app_id" }, type: { name: "type" } },
}));

const mockGetByokKey = vi.fn().mockResolvedValue("fake-anthropic-key");
const mockGetAppKey = vi.fn().mockResolvedValue("fake-app-key");

vi.mock("../../src/lib/key-client.js", () => ({
  getByokKey: (...args: unknown[]) => mockGetByokKey(...args),
  getAppKey: (...args: unknown[]) => mockGetAppKey(...args),
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

describe("POST /generate (template-based)", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-456" });
    mockPromptFindFirst.mockResolvedValue({
      id: "prompt-1",
      appId: "my-app",
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
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "my-app",
        type: "email",
        variables: {
          recipientInfo: "Name: John Doe\nCompany: Acme Corp",
          senderInfo: "Name: MyBrand\nURL: https://mybrand.com",
        },
        keyMode: "byok",
        runId: "run-parent-1",
      })
      .expect(200);

    expect(res.body.subject).toBe("Test subject");
    expect(res.body.sequence).toHaveLength(3);
    expect(res.body.sequence[0].bodyText).toBe("Test body");
    expect(res.body.id).toBe("gen-789");

    // Verify generateFromTemplate was called with the stored prompt template + variables
    expect(mockGenerateFromTemplate).toHaveBeenCalledWith(
      "fake-anthropic-key",
      {
        promptTemplate: "Write an email.\n\n## Recipient\n{{recipientInfo}}\n\n## Sender\n{{senderInfo}}",
        variables: {
          recipientInfo: "Name: John Doe\nCompany: Acme Corp",
          senderInfo: "Name: MyBrand\nURL: https://mybrand.com",
        },
        includeAiDisclaimer: false,
      }
    );
  });

  it("returns 404 when no prompt found for app + type", async () => {
    mockPromptFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .post("/generate")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "unknown-app",
        type: "email",
        variables: {},
        keyMode: "byok",
        runId: "run-1",
      })
      .expect(404);

    expect(res.body.error).toContain("No prompt found");
  });

  it("returns 400 when required fields are missing", async () => {
    await request(app)
      .post("/generate")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ appId: "my-app" }) // missing type, variables, runId
      .expect(400);
  });

  it("works with optional fields (brandId, campaignId, apolloEnrichmentId)", async () => {
    await request(app)
      .post("/generate")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "my-app",
        type: "email",
        variables: { recipientInfo: "test", senderInfo: "test" },
        keyMode: "byok",
        runId: "run-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
        apolloEnrichmentId: "enrich-1",
      })
      .expect(200);
  });

  it("uses getByokKey when keyMode is byok", async () => {
    await request(app)
      .post("/generate")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "my-app",
        type: "email",
        variables: { recipientInfo: "test", senderInfo: "test" },
        keyMode: "byok",
        runId: "run-1",
      })
      .expect(200);

    expect(mockGetByokKey).toHaveBeenCalledWith("org_test", "anthropic", { callerMethod: "POST", callerPath: "/generate" });
    expect(mockGetAppKey).not.toHaveBeenCalled();
  });

  it("uses getAppKey when keyMode is app", async () => {
    await request(app)
      .post("/generate")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "my-app",
        type: "email",
        variables: { recipientInfo: "test", senderInfo: "test" },
        keyMode: "app",
        runId: "run-1",
      })
      .expect(200);

    expect(mockGetAppKey).toHaveBeenCalledWith("my-app", "anthropic", { callerMethod: "POST", callerPath: "/generate" });
    expect(mockGetByokKey).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid keyMode", async () => {
    const res = await request(app)
      .post("/generate")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "my-app",
        type: "email",
        variables: { recipientInfo: "test", senderInfo: "test" },
        keyMode: "invalid",
        runId: "run-1",
      })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("accepts array and object variable values (regression: windmill sends non-strings)", async () => {
    const res = await request(app)
      .post("/generate")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "my-app",
        type: "email",
        variables: {
          recipientInfo: "Name: John",
          senderInfo: "MyBrand",
          personTitles: ["Executive Director", "Program Manager"],
          searchParams: { qKeywords: "blockchain OR web3" },
          tags: ["sales", "outreach"],
        },
        keyMode: "byok",
        runId: "run-1",
      })
      .expect(200);

    expect(res.body.id).toBe("gen-789");
  });
});
