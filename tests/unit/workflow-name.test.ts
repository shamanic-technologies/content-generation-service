import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests that workflowSlug is accepted, stored in DB, and passed to runs-service
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

// Track DB inserts to verify workflowSlug is stored
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
      { step: 1, bodyHtml: "<p>Test</p>", bodyText: "Test", daysSinceLastStep: 0 },
    ],
    tokensInput: 100,
    tokensOutput: 50,
    model: "claude-sonnet-4-6",
    promptRaw: "test prompt",
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


function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("workflowSlug propagation", () => {
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

    it("should pass workflowSlug to createRun when provided", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .send({
          type: "email",
          variables: { recipientName: "John" },
          workflowSlug: "cold-email-outreach",
        })
        .expect(200);

      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowSlug: "cold-email-outreach",
        }),
        expect.objectContaining({
          orgId: "org-internal-123",
          userId: "user-internal-456",
        })
      );
    });

    it("should store workflowSlug in the database", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .send({
          type: "email",
          variables: { recipientName: "John" },
          workflowSlug: "cold-email-outreach",
        })
        .expect(200);

      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          workflowSlug: "cold-email-outreach",
        })
      );
    });

    it("should work without workflowSlug (optional)", async () => {
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
          workflowSlug: undefined,
        }),
        expect.objectContaining({
          orgId: "org-internal-123",
          userId: "user-internal-456",
        })
      );
      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          workflowSlug: null,
        })
      );
    });
  });

});
