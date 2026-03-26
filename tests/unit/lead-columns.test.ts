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

// Mock DB — capture values passed to insert
const mockValues = vi.fn().mockReturnValue({
  returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
});
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
const mockPromptFindFirst = vi.fn();
const mockEmailGenFindFirst = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
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
        findFirst: (...args: unknown[]) => mockEmailGenFindFirst(...args),
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailGenerations: { id: { name: "id" }, orgId: { name: "org_id" }, idempotencyKey: { name: "idempotency_key" } },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

vi.mock("../../src/lib/key-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "fake-anthropic-key", keySource: "platform" as const }),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredits: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 5000, required_cents: 1 }),
  ESTIMATED_INPUT_TOKENS: 2000,
  ESTIMATED_OUTPUT_TOKENS: 3072,
}));

vi.mock("../../src/lib/campaign-client.js", () => ({
  getCampaignFeatureInputs: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../src/lib/anthropic-client.js", () => ({
  generateFromTemplate: vi.fn().mockResolvedValue({
    subject: "Test subject",
    sequence: [
      { step: 1, bodyHtml: "<p>Test body</p>", bodyText: "Test body", daysSinceLastStep: 0 },
      { step: 2, bodyHtml: "<p>Follow-up 1</p>", bodyText: "Follow-up 1", daysSinceLastStep: 3 },
      { step: 3, bodyHtml: "<p>Follow-up 2</p>", bodyText: "Follow-up 2", daysSinceLastStep: 7 },
    ],
    tokensInput: 500,
    tokensOutput: 100,
    promptRaw: "resolved prompt",
    responseRaw: {},
  }),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("POST /generate — lead/client column population", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
    });
    mockPromptFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: "org-internal-123",
      type: "email",
      prompt: "Write an email to {{leadFirstName}}",
      variables: ["leadFirstName"],
    });

    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("populates lead columns from variables", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        variables: {
          leadFirstName: "Ray",
          leadLastName: "Chen",
          leadTitle: "Managing Partner",
          leadCompanyName: "Acme Corp",
          leadCompanyIndustry: "IT consulting",
          clientCompanyName: "MyBrand",
        },
      })
      .expect(200);

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.leadFirstName).toBe("Ray");
    expect(insertedValues.leadLastName).toBe("Chen");
    expect(insertedValues.leadTitle).toBe("Managing Partner");
    expect(insertedValues.leadCompany).toBe("Acme Corp");
    expect(insertedValues.leadIndustry).toBe("IT consulting");
    expect(insertedValues.clientCompanyName).toBe("MyBrand");
  });

  it("sets lead columns to null when variables are missing", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        variables: { someOtherVar: "value" },
      })
      .expect(200);

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.leadFirstName).toBeNull();
    expect(insertedValues.leadLastName).toBeNull();
    expect(insertedValues.leadTitle).toBeNull();
    expect(insertedValues.leadCompany).toBeNull();
    expect(insertedValues.leadIndustry).toBeNull();
    expect(insertedValues.clientCompanyName).toBeNull();
  });

  it("ignores non-string variable values for lead columns", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        variables: {
          leadFirstName: 123,
          leadLastName: ["array"],
          leadCompanyName: { nested: true },
          leadTitle: "Valid Title",
        },
      })
      .expect(200);

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.leadFirstName).toBeNull();
    expect(insertedValues.leadLastName).toBeNull();
    expect(insertedValues.leadCompany).toBeNull();
    expect(insertedValues.leadTitle).toBe("Valid Title");
  });

  it("ignores empty string variable values for lead columns", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        variables: {
          leadFirstName: "",
          leadLastName: "Chen",
        },
      })
      .expect(200);

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.leadFirstName).toBeNull();
    expect(insertedValues.leadLastName).toBe("Chen");
  });

  it("still stores full variables in variablesRaw", async () => {
    const variables = {
      leadFirstName: "Ray",
      leadCompanyName: "Acme Corp",
      customField: "custom value",
    };

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        variables,
      })
      .expect(200);

    const insertedValues = mockValues.mock.calls[0][0];
    expect(insertedValues.variablesRaw).toEqual(variables);
  });
});
