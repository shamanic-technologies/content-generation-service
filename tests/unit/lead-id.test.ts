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
    campaignId: { name: "campaign_id" },
    brandIds: { name: "brand_ids" },
    createdAt: { name: "created_at" },
  },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

vi.mock("../../src/lib/campaign-client.js", () => ({
  getCampaignFeatureInputs: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../src/lib/chat-service-client.js", () => ({
  generateFromTemplate: vi.fn().mockResolvedValue({
    subject: "Test subject",
    sequence: [
      { step: 1, bodyHtml: "<p>Test body</p>", bodyText: "Test body", daysSinceLastStep: 0 },
      { step: 2, bodyHtml: "<p>Follow-up</p>", bodyText: "Follow-up", daysSinceLastStep: 3 },
    ],
    tokensInput: 500,
    tokensOutput: 100,
    model: "claude-sonnet-4-6",
    promptRaw: "resolved prompt",
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

const validBody = {
  type: "email",
  variables: { recipientInfo: "John Doe" },
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
      orgId: "org-internal-123",
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
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .send({ ...validBody, leadId: "lead-abc-123" })
        .expect(200);

      const insertedValues = mockValues.mock.calls[0][0];
      expect(insertedValues.leadId).toBe("lead-abc-123");
    });

    it("stores leadId as null when not provided (backward compat)", async () => {
      await request(app)
        .post("/generate")
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
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
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .expect(200);

      expect(res.body.generation.id).toBe("gen-found");
      expect(res.body.generation.leadId).toBe("lead-abc-123");
    });

    it("returns 404 when no generation exists for leadId", async () => {
      mockGenFindFirst.mockResolvedValue(null);

      const res = await request(app)
        .get("/generations/by-lead/lead-nonexistent")
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .expect(404);

      expect(res.body.error).toBe("Generation not found");
    });

    it("unscoped read is unchanged — no orderBy passed (byte-compatible)", async () => {
      mockGenFindFirst.mockResolvedValue({ id: "gen-x", leadId: "lead-abc-123" });

      await request(app)
        .get("/generations/by-lead/lead-abc-123")
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .expect(200);

      const opts = mockGenFindFirst.mock.calls[0][0] as { where?: unknown; orderBy?: unknown };
      expect(opts.where).toBeDefined();
      // The unscoped path must not add ordering (returning the same arbitrary row as before).
      expect(opts.orderBy).toBeUndefined();
    });

    it("brand-scoped read returns the requested brand's generation (most recent)", async () => {
      // Person has generations under two brands; the brand-A read must return brand A's.
      // (The DB is fully mocked, so we assert the scoped query path executes and the
      // resolved brand-A row is returned — not brand B's.)
      const brandAGeneration = {
        id: "gen-brand-a",
        leadId: "lead-multi-brand",
        brandIds: ["brand-A"],
        subject: "Pitching Brand A",
        sequence: [],
      };
      mockGenFindFirst.mockResolvedValue(brandAGeneration);

      const res = await request(app)
        .get("/generations/by-lead/lead-multi-brand?brandId=brand-A")
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .expect(200);

      expect(res.body.generation.id).toBe("gen-brand-a");
      expect(res.body.generation.brandIds).toEqual(["brand-A"]);

      // Scoped path: a brand filter + newest-first ordering are applied.
      const opts = mockGenFindFirst.mock.calls[0][0] as { where?: unknown; orderBy?: unknown };
      expect(opts.where).toBeDefined();
      expect(opts.orderBy).toBeDefined();
    });

    it("returns 404 (empty state, not 500) when lead has no generation under the requested brand", async () => {
      // Person exists under brand B only; scoping to brand A finds nothing.
      mockGenFindFirst.mockResolvedValue(null);

      const res = await request(app)
        .get("/generations/by-lead/lead-multi-brand?brandId=brand-A")
        .set("X-Org-Id", "org-internal-123")
        .set("X-User-Id", "user-internal-456")
        .expect(404);

      expect(res.body.error).toBe("Generation not found");
    });
  });
});
