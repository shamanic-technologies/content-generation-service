import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests that x-campaign-id, x-brand-id, x-workflow-slug headers are:
 * 1. Parsed from request headers as optional fallbacks
 * 2. Used when body fields are missing
 * 3. Body values take precedence over header values
 * 4. Forwarded to runs-service via identity headers
 */

// Mock runs-client — capture identity headers passed to createRun
const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-456" });
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

// Use real serviceAuth to test header parsing
vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return actual;
});

// Track DB inserts
const mockInsertValues: Array<Record<string, unknown>> = [];

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
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      prompts: {
        findFirst: vi.fn().mockResolvedValue({
          id: "prompt-1",
          orgId: "org-123",
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
  decryptKey: vi.fn().mockResolvedValue({ key: "fake-key", keySource: "platform" as const }),
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

describe("tracking headers (x-campaign-id, x-brand-id, x-workflow-slug, x-feature-slug)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertValues.length = 0;
  });

  describe("POST /generate", () => {
    let app: express.Express;

    beforeEach(async () => {
      app = createTestApp();
      const { default: generateRoutes } = await import("../../src/routes/generate.js");
      app.use(generateRoutes);
    });

    it("uses header values when body fields are absent", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-123")
        .set("X-User-Id", "user-456")
        .set("X-Run-Id", "run-789")
        .set("X-Campaign-Id", "campaign-from-header")
        .set("X-Brand-Id", "brand-from-header")
        .set("X-Workflow-Slug", "wf-from-header")
        .set("X-Feature-Slug", "feat-from-header")
        .send({
          type: "email",
          variables: { recipientName: "John" },
        })
        .expect(200);

      // DB insert should use header values
      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          brandId: "brand-from-header",
          campaignId: "campaign-from-header",
          workflowSlug: "wf-from-header",
          featureSlug: "feat-from-header",
        })
      );

      // createRun should receive header values in both body and identity
      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          brandId: "brand-from-header",
          campaignId: "campaign-from-header",
          workflowSlug: "wf-from-header",
        }),
        expect.objectContaining({
          campaignId: "campaign-from-header",
          brandId: "brand-from-header",
          workflowSlug: "wf-from-header",
          featureSlug: "feat-from-header",
        })
      );
    });

    it("body values take precedence over header values", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-123")
        .set("X-User-Id", "user-456")
        .set("X-Run-Id", "run-789")
        .set("X-Campaign-Id", "campaign-from-header")
        .set("X-Brand-Id", "brand-from-header")
        .set("X-Workflow-Slug", "wf-from-header")
        .set("X-Feature-Slug", "feat-from-header")
        .send({
          type: "email",
          variables: { recipientName: "John" },
          brandId: "brand-from-body",
          campaignId: "campaign-from-body",
          workflowSlug: "wf-from-body",
          featureSlug: "feat-from-body",
        })
        .expect(200);

      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          brandId: "brand-from-body",
          campaignId: "campaign-from-body",
          workflowSlug: "wf-from-body",
          featureSlug: "feat-from-body",
        })
      );
    });

    it("works without any tracking headers or body fields", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-123")
        .set("X-User-Id", "user-456")
        .set("X-Run-Id", "run-789")
        .send({
          type: "email",
          variables: { recipientName: "John" },
        })
        .expect(200);

      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          brandId: "",
          campaignId: "",
          workflowSlug: null,
          featureSlug: null,
        })
      );
    });

    it("forwards tracking headers to runs-service addCosts and updateRun", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-123")
        .set("X-User-Id", "user-456")
        .set("X-Run-Id", "run-789")
        .set("X-Campaign-Id", "camp-1")
        .set("X-Brand-Id", "brand-1")
        .set("X-Workflow-Slug", "wf-1")
        .set("X-Feature-Slug", "feat-1")
        .send({
          type: "email",
          variables: { recipientName: "John" },
        })
        .expect(200);

      // addCosts identity should include tracking headers
      expect(mockAddCosts).toHaveBeenCalledWith(
        "run-456",
        expect.any(Array),
        expect.objectContaining({
          campaignId: "camp-1",
          brandId: "brand-1",
          workflowSlug: "wf-1",
          featureSlug: "feat-1",
        })
      );

      // updateRun identity should include tracking headers
      expect(mockUpdateRun).toHaveBeenCalledWith(
        "run-456",
        "completed",
        expect.objectContaining({
          campaignId: "camp-1",
          brandId: "brand-1",
          workflowSlug: "wf-1",
          featureSlug: "feat-1",
        })
      );
    });
  });
});
