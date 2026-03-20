import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests that workflowName is accepted, stored in DB, and passed to runs-service
 * across all generation endpoints.
 */

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

// Track DB inserts to verify workflowName is stored
const mockInsertValues: Array<Record<string, unknown>> = [];
const mockDbSetCalls: Array<Record<string, unknown>> = [];

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        mockInsertValues.push(data);
        return {
          returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
        };
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        mockDbSetCalls.push(data);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    query: {
      prompts: {
        findFirst: vi.fn().mockResolvedValue({
          id: "prompt-1",
          orgId: "org-internal-123",
          type: "email",
          prompt: "Write an email to {{recipientName}}",
          variables: ["recipientName"],
        }),
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
  authorizeCredits: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 5000 }),
  estimateGenerationCostCents: vi.fn().mockReturnValue(6),
}));

vi.mock("../../src/lib/anthropic-client.js", () => ({
  generateFromTemplate: vi.fn().mockResolvedValue({
    subject: "Test subject",
    sequence: [
      { step: 1, bodyHtml: "<p>Test</p>", bodyText: "Test", daysSinceLastStep: 0 },
    ],
    tokensInput: 100,
    tokensOutput: 50,
    promptRaw: "test prompt",
    responseRaw: {},
  }),
}));


function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("workflowName propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertValues.length = 0;
    mockDbSetCalls.length = 0;
  });

  describe("POST /generate", () => {
    let app: express.Express;

    beforeEach(async () => {
      app = createTestApp();
      const { default: generateRoutes } = await import("../../src/routes/generate.js");
      app.use(generateRoutes);
    });

    it("should pass workflowName to createRun when provided", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .send({
          type: "email",
          variables: { recipientName: "John" },
          workflowName: "cold-email-outreach",
        })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowName: "cold-email-outreach",
        }),
        expect.objectContaining({
          orgId: "org-internal-123",
          userId: "user-internal-456",
        })
      );
    });

    it("should store workflowName in the database", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .send({
          type: "email",
          variables: { recipientName: "John" },
          workflowName: "cold-email-outreach",
        })
        .expect(200);

      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          workflowName: "cold-email-outreach",
        })
      );
    });

    it("should work without workflowName (optional)", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .send({
          type: "email",
          variables: { recipientName: "John" },
        })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowName: undefined,
        }),
        expect.objectContaining({
          orgId: "org-internal-123",
          userId: "user-internal-456",
        })
      );
      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          workflowName: null,
        })
      );
    });
  });

});
