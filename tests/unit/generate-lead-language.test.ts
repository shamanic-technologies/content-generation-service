import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-456" });
const mockUpdateRun = vi.fn().mockResolvedValue({});

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "org-1";
    req.userId = "user-1";
    req.runId = "run-1";
    next();
  },
}));

const mockValues = vi.fn().mockReturnValue({
  returning: vi.fn().mockResolvedValue([{ id: "gen-1" }]),
});
const mockPromptFindFirst = vi.fn();
const mockGenFindFirst = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: (...a: unknown[]) => mockValues(...a) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
    query: {
      prompts: { findFirst: (...a: unknown[]) => mockPromptFindFirst(...a) },
      emailGenerations: {
        findFirst: (...a: unknown[]) => mockGenFindFirst(...a),
        findMany: vi.fn(),
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

const mockGetLeadLanguages = vi.fn();
vi.mock("../../src/lib/lead-client.js", () => ({
  getLeadLanguages: (...a: unknown[]) => mockGetLeadLanguages(...a),
}));

const mockGenerateFromTemplate = vi.fn();
vi.mock("../../src/lib/chat-service-client.js", () => ({
  generateFromTemplate: (...a: unknown[]) => mockGenerateFromTemplate(...a),
  substituteVariables: (t: string) => t,
  findUnfilledPlaceholders: () => [],
  InsufficientCreditsError: class extends Error {},
  ExpertQuotePitchLengthError: class extends Error {},
  generateExpertQuotePitchFromTemplate: vi.fn(),
}));

const body = { type: "email", variables: {}, leadId: "lead-1", campaignId: "camp-1" };

describe("POST /generate — writing in the lead's language", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPromptFindFirst.mockResolvedValue({
      id: "p-1",
      type: "email",
      prompt: "Write an email.",
      variables: [],
    });
    mockGenFindFirst.mockResolvedValue(null);
    mockValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "gen-1" }]),
    });
    mockGenerateFromTemplate.mockResolvedValue({
      subject: "s",
      sequence: [],
      tokensInput: 1,
      tokensOutput: 1,
      model: "m",
      promptRaw: "p",
      responseRaw: {},
    });

    app = express();
    app.use(express.json());
    const { default: routes } = await import("../../src/routes/generate.js");
    app.use(routes);
  });

  it("passes the leading language when the lead reads no English", async () => {
    mockGetLeadLanguages.mockResolvedValue(["German"]);
    await request(app).post("/generate").send(body).expect(200);
    expect(mockGenerateFromTemplate.mock.calls[0][0].language).toBe("German");
  });

  it("passes no language when English is anywhere in the list", async () => {
    mockGetLeadLanguages.mockResolvedValue(["German", "English"]);
    await request(app).post("/generate").send(body).expect(200);
    expect(mockGenerateFromTemplate.mock.calls[0][0].language).toBeNull();
  });

  it("passes no language when the lead reports none", async () => {
    mockGetLeadLanguages.mockResolvedValue(null);
    await request(app).post("/generate").send(body).expect(200);
    expect(mockGenerateFromTemplate.mock.calls[0][0].language).toBeNull();
  });

  it("does not call lead-service at all when the request carries no leadId", async () => {
    const { leadId: _drop, ...noLead } = body;
    await request(app).post("/generate").send(noLead).expect(200);
    expect(mockGetLeadLanguages).not.toHaveBeenCalled();
    expect(mockGenerateFromTemplate.mock.calls[0][0].language).toBeNull();
  });

  it("forwards identity + attribution to lead-service", async () => {
    mockGetLeadLanguages.mockResolvedValue(["Italian"]);
    await request(app).post("/generate").send(body).expect(200);
    const [leadId, identity] = mockGetLeadLanguages.mock.calls[0];
    expect(leadId).toBe("lead-1");
    expect(identity).toMatchObject({ orgId: "org-1", userId: "user-1", runId: "run-1", campaignId: "camp-1" });
  });

  it("answers a retried lead from storage without asking lead-service anything", async () => {
    // The stored-generation path returns before any downstream call. A retry must
    // not pay for a lead-service round trip any more than it pays for a completion.
    mockGenFindFirst.mockResolvedValue({
      id: "gen-existing",
      subject: "stored",
      sequence: [],
      tokensInput: 10,
      tokensOutput: 20,
    });
    await request(app).post("/generate").send(body).expect(200);
    expect(mockGetLeadLanguages).not.toHaveBeenCalled();
    expect(mockGenerateFromTemplate).not.toHaveBeenCalled();
  });
});
