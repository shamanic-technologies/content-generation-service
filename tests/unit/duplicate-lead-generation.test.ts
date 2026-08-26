import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// A lead that is legitimately retried (paid for, served, never contacted) already has an
// `email_generations` row for its campaign. `idx_emailgen_lead` is UNIQUE on
// (campaign_id, lead_id), so the second generation used to throw on INSERT — after the
// chat-service completion had already run and been billed — and that throw failed the whole
// workflow run. These tests pin that the stored email is returned instead, with no completion
// billed, and that the concurrent case is closed too. See issue #186.

const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-456" });
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-internal-123";
    req.userId = req.headers["x-user-id"] || "user-internal-456";
    req.runId = req.headers["x-run-id"] || "run-caller-123";
    next();
  },
}));

const mockPromptFindFirst = vi.fn();
const mockGenFindFirst = vi.fn();
const mockReturning = vi.fn();
const mockValues = vi.fn().mockReturnValue({ returning: (...a: unknown[]) => mockReturning(...a) });
const mockInsert = vi.fn().mockReturnValue({ values: (...a: unknown[]) => mockValues(...a) });

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
  },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

vi.mock("../../src/lib/campaign-client.js", () => ({
  getCampaignFeatureInputs: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn().mockResolvedValue(new Map()),
}));

const mockGenerateFromTemplate = vi.fn();

vi.mock("../../src/lib/chat-service-client.js", () => ({
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

/** The shape postgres.js raises for a unique-index violation. */
function pgUniqueViolation(constraint: string) {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`) as Error & {
    code: string;
    constraint_name: string;
  };
  err.code = "23505";
  err.constraint_name = constraint;
  return err;
}

const CAMPAIGN_ID = "9bc27ed7-2fd5-4fb4-b523-026eb919e8ae";
const LEAD_ID = "4f54e89f-9e03-4441-a389-30a7dc787a07";

const storedGeneration = {
  id: "gen-from-2026-08-13",
  subject: "The email this lead was already written",
  sequence: [
    { step: 1, bodyHtml: "<p>Stored</p>", bodyText: "Stored", daysSinceLastStep: 0 },
    { step: 2, bodyHtml: "<p>Stored f1</p>", bodyText: "Stored f1", daysSinceLastStep: 3 },
  ],
  tokensInput: 7524,
  tokensOutput: 388,
};

const validBody = {
  type: "email",
  variables: { recipientInfo: "John Doe" },
};

describe("POST /generate — a lead that already has a generation", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-456" });
    mockPromptFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: "org-internal-123",
      type: "email",
      prompt: "Write an email.\n\n{{recipientInfo}}",
      variables: ["recipientInfo"],
    });
    mockGenFindFirst.mockResolvedValue(null);
    mockReturning.mockResolvedValue([{ id: "gen-fresh" }]);
    mockGenerateFromTemplate.mockResolvedValue({
      subject: "Fresh subject",
      sequence: [{ step: 1, bodyHtml: "<p>Fresh</p>", bodyText: "Fresh", daysSinceLastStep: 0 }],
      tokensInput: 500,
      tokensOutput: 100,
      model: "gemini-3.1-pro-preview",
      promptRaw: "resolved prompt",
      responseRaw: {},
    });

    app = express();
    app.use(express.json());
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("returns the stored email and bills no completion", async () => {
    mockGenFindFirst.mockResolvedValue(storedGeneration);

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, leadId: LEAD_ID, campaignId: CAMPAIGN_ID })
      .expect(200);

    expect(res.body.id).toBe("gen-from-2026-08-13");
    expect(res.body.subject).toBe(storedGeneration.subject);
    expect(res.body.sequence).toHaveLength(2);

    // The whole point: no LLM call, so nothing is billed and nothing is discarded.
    expect(mockGenerateFromTemplate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("looks the lead up under the campaign the insert would have used", async () => {
    mockGenFindFirst.mockResolvedValue(storedGeneration);

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, leadId: LEAD_ID, campaignId: CAMPAIGN_ID })
      .expect(200);

    expect(mockGenFindFirst).toHaveBeenCalledOnce();
    expect((mockGenFindFirst.mock.calls[0][0] as { where?: unknown }).where).toBeDefined();
  });

  it("still looks up when the request carries no campaignId (the '' campaign the column stores)", async () => {
    mockGenFindFirst.mockResolvedValue(storedGeneration);

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, leadId: LEAD_ID })
      .expect(200);

    expect(res.body.id).toBe("gen-from-2026-08-13");
    expect(mockGenerateFromTemplate).not.toHaveBeenCalled();
  });

  it("generates normally for a lead with no prior generation", async () => {
    mockGenFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, leadId: LEAD_ID, campaignId: CAMPAIGN_ID })
      .expect(200);

    expect(res.body.id).toBe("gen-fresh");
    expect(res.body.subject).toBe("Fresh subject");
    expect(mockGenerateFromTemplate).toHaveBeenCalledOnce();
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("does not look up at all when the request carries no leadId", async () => {
    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, campaignId: CAMPAIGN_ID })
      .expect(200);

    expect(res.body.id).toBe("gen-fresh");
    expect(mockGenFindFirst).not.toHaveBeenCalled();
    expect(mockGenerateFromTemplate).toHaveBeenCalledOnce();
  });
});

describe("POST /generate — two retries of the same lead race on the insert", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-456" });
    mockPromptFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: "org-internal-123",
      type: "email",
      prompt: "Write an email.\n\n{{recipientInfo}}",
      variables: ["recipientInfo"],
    });
    mockGenerateFromTemplate.mockResolvedValue({
      subject: "Fresh subject",
      sequence: [{ step: 1, bodyHtml: "<p>Fresh</p>", bodyText: "Fresh", daysSinceLastStep: 0 }],
      tokensInput: 500,
      tokensOutput: 100,
      model: "gemini-3.1-pro-preview",
      promptRaw: "resolved prompt",
      responseRaw: {},
    });

    app = express();
    app.use(express.json());
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("returns the winning generation instead of throwing the duplicate key", async () => {
    // Lookup misses (the other retry has not inserted yet), then the insert loses the race.
    mockGenFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(storedGeneration);
    mockReturning.mockRejectedValue(pgUniqueViolation("idx_emailgen_lead"));

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, leadId: LEAD_ID, campaignId: CAMPAIGN_ID })
      .expect(200);

    expect(res.body.id).toBe("gen-from-2026-08-13");
    expect(mockGenerateFromTemplate).toHaveBeenCalledOnce();
    expect(mockGenFindFirst).toHaveBeenCalledTimes(2);
  });

  it("fails loud on a unique violation from a different index", async () => {
    mockGenFindFirst.mockResolvedValue(null);
    mockReturning.mockRejectedValue(pgUniqueViolation("idx_emailgen_idempotency"));

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, leadId: LEAD_ID, campaignId: CAMPAIGN_ID })
      .expect(500);
  });

  it("fails loud when the duplicate key names our index but no row can be read back", async () => {
    mockGenFindFirst.mockResolvedValue(null);
    mockReturning.mockRejectedValue(pgUniqueViolation("idx_emailgen_lead"));

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, leadId: LEAD_ID, campaignId: CAMPAIGN_ID })
      .expect(500);
  });

  it("fails loud on a non-duplicate insert error", async () => {
    mockGenFindFirst.mockResolvedValue(null);
    mockReturning.mockRejectedValue(new Error("connection terminated unexpectedly"));

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, leadId: LEAD_ID, campaignId: CAMPAIGN_ID })
      .expect(500);
  });
});
