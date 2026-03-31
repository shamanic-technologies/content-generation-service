import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests multi-brand support:
 * 1. x-brand-id header is parsed as CSV into brandIds array
 * 2. brandIds array is stored in the DB insert
 * 3. Body brandIds array takes precedence over header
 * 4. Single brand still works (backward compat)
 * 5. Stats queries filter by array containment
 */

const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-456" });
const mockUpdateRun = vi.fn().mockResolvedValue({});

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
}));

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return actual;
});

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
    subject: "Test",
    sequence: [{ step: 1, bodyHtml: "<p>Hi</p>", bodyText: "Hi", daysSinceLastStep: 0 }],
    tokensInput: 100,
    tokensOutput: 50,
    model: "claude-sonnet-4-6",
    promptRaw: "prompt",
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

describe("multi-brand support (x-brand-id CSV)", () => {
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

    it("parses CSV x-brand-id header into brandIds array for DB storage", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-123")
        .set("X-User-Id", "user-456")
        .set("X-Run-Id", "run-789")
        .set("X-Brand-Id", "brand-1,brand-2,brand-3")
        .send({
          type: "email",
          variables: { recipientName: "John" },
        })
        .expect(200);

      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          brandIds: ["brand-1", "brand-2", "brand-3"],
        })
      );
    });

    it("handles single brand UUID in header (backward compat)", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-123")
        .set("X-User-Id", "user-456")
        .set("X-Run-Id", "run-789")
        .set("X-Brand-Id", "brand-1")
        .send({
          type: "email",
          variables: { recipientName: "John" },
        })
        .expect(200);

      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          brandIds: ["brand-1"],
        })
      );
    });

    it("trims whitespace in CSV brand IDs", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-123")
        .set("X-User-Id", "user-456")
        .set("X-Run-Id", "run-789")
        .set("X-Brand-Id", " brand-1 , brand-2 , brand-3 ")
        .send({
          type: "email",
          variables: { recipientName: "John" },
        })
        .expect(200);

      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          brandIds: ["brand-1", "brand-2", "brand-3"],
        })
      );
    });

    it("body brandIds array takes precedence over header", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-123")
        .set("X-User-Id", "user-456")
        .set("X-Run-Id", "run-789")
        .set("X-Brand-Id", "header-brand-1,header-brand-2")
        .send({
          type: "email",
          variables: { recipientName: "John" },
          brandIds: ["body-brand-1", "body-brand-2"],
        })
        .expect(200);

      expect(mockInsertValues[0]).toEqual(
        expect.objectContaining({
          brandIds: ["body-brand-1", "body-brand-2"],
        })
      );
    });

    it("stores empty array when no brand header or body", async () => {
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
          brandIds: [],
        })
      );
    });

    it("forwards CSV brand string to downstream services via identity", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-123")
        .set("X-User-Id", "user-456")
        .set("X-Run-Id", "run-789")
        .set("X-Brand-Id", "brand-1,brand-2")
        .send({
          type: "email",
          variables: { recipientName: "John" },
        })
        .expect(200);

      // createRun identity should carry the CSV string for header forwarding
      expect(mockCreateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          brandId: "brand-1,brand-2",
        }),
        expect.objectContaining({
          brandId: "brand-1,brand-2",
        })
      );
    });
  });
});
