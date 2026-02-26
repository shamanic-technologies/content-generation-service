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
    req.externalOrgId = req.headers["x-org-id"] || "org_test";
    next();
  },
}));

// Mock DB
const mockValues = vi.fn().mockReturnValue({
  returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
});
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
const mockPromptFindFirst = vi.fn();
const mockGenFindFirst = vi.fn();
const mockGenFindMany = vi.fn();

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
        findFirst: (...args: unknown[]) => mockGenFindFirst(...args),
        findMany: (...args: unknown[]) => mockGenFindMany(...args),
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailGenerations: {
    id: { name: "id" },
    orgId: { name: "org_id" },
    idempotencyKey: { name: "idempotency_key" },
    leadId: { name: "lead_id" },
  },
  prompts: { appId: { name: "app_id" }, type: { name: "type" } },
}));

vi.mock("../../src/lib/key-client.js", () => ({
  getByokKey: vi.fn().mockResolvedValue("fake-anthropic-key"),
  getAppKey: vi.fn().mockResolvedValue("fake-app-key"),
}));

vi.mock("../../src/lib/anthropic-client.js", () => ({
  generateFromTemplate: vi.fn().mockResolvedValue({
    subject: "Test subject",
    sequence: [
      { step: 1, bodyHtml: "<p>Test body</p>", bodyText: "Test body", daysSinceLastStep: 0 },
      { step: 2, bodyHtml: "<p>Follow-up</p>", bodyText: "Follow-up", daysSinceLastStep: 3 },
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

const validBody = {
  appId: "my-app",
  type: "email",
  variables: { recipientInfo: "John Doe" },
  keyMode: "byok" as const,
  runId: "run-parent-1",
};

describe("leadId support", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
    });
    mockPromptFindFirst.mockResolvedValue({
      id: "prompt-1",
      appId: "my-app",
      type: "email",
      prompt: "Write an email.\n\n{{recipientInfo}}",
      variables: ["recipientInfo"],
    });
    mockGenFindFirst.mockResolvedValue(null);

    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  describe("POST /generate — leadId storage", () => {
    it("stores leadId in DB when provided", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org_test")
        .send({ ...validBody, leadId: "lead-abc-123" })
        .expect(200);

      const insertedValues = mockValues.mock.calls[0][0];
      expect(insertedValues.leadId).toBe("lead-abc-123");
    });

    it("stores leadId as null when not provided (backward compat)", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org_test")
        .send(validBody)
        .expect(200);

      const insertedValues = mockValues.mock.calls[0][0];
      expect(insertedValues.leadId).toBeNull();
    });
  });

  describe("GET /generations/by-lead/:leadId", () => {
    it("returns generation when leadId matches", async () => {
      const mockGeneration = {
        id: "gen-found",
        leadId: "lead-abc-123",
        subject: "Found subject",
        sequence: [],
      };
      mockGenFindFirst.mockResolvedValue(mockGeneration);

      const res = await request(app)
        .get("/generations/by-lead/lead-abc-123")
        .set("X-Org-Id", "org_test")
        .expect(200);

      expect(res.body.generation.id).toBe("gen-found");
      expect(res.body.generation.leadId).toBe("lead-abc-123");
    });

    it("returns 404 when no generation exists for leadId", async () => {
      mockGenFindFirst.mockResolvedValue(null);

      const res = await request(app)
        .get("/generations/by-lead/lead-nonexistent")
        .set("X-Org-Id", "org_test")
        .expect(404);

      expect(res.body.error).toBe("Generation not found");
    });
  });
});
