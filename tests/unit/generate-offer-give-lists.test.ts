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

const mockGetBusinessLanguages = vi.fn();
vi.mock("../../src/lib/lead-client.js", () => ({
  getLeadBusinessLanguages: (...a: unknown[]) => mockGetBusinessLanguages(...a),
}));

const mockFetchGiveLists = vi.fn();
vi.mock("../../src/lib/offer-give-lists-client.js", () => ({
  fetchOfferGiveLists: (...a: unknown[]) => mockFetchGiveLists(...a),
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

const OFFER = "9a1b2c3d-0000-4000-8000-000000000001";
const body = { type: "email", variables: {}, campaignId: "camp-1", brandIds: ["brand-1"], offerId: OFFER };

describe("POST /generate — the offer's give lists", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockPromptFindFirst.mockResolvedValue({ id: "p-1", type: "email", prompt: "Write an email.", variables: [] });
    mockGenFindFirst.mockResolvedValue(null);
    mockValues.mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "gen-1" }]) });
    mockGetBusinessLanguages.mockResolvedValue(null);
    mockFetchGiveLists.mockResolvedValue({ giveForFree: [], neverGive: [] });
    mockGenerateFromTemplate.mockResolvedValue({
      subject: "s", sequence: [], tokensInput: 1, tokensOutput: 1, model: "m", promptRaw: "p", responseRaw: {},
    });
    app = express();
    app.use(express.json());
    const { default: routes } = await import("../../src/routes/generate.js");
    app.use(routes);
  });

  it("reads the campaign's offer and hands its lists to the writer", async () => {
    const lists = { giveForFree: ["A free pipeline audit"], neverGive: ["Discounts"] };
    mockFetchGiveLists.mockResolvedValue(lists);
    await request(app).post("/generate").send(body).expect(200);
    const [identity] = mockFetchGiveLists.mock.calls[0];
    expect(identity).toMatchObject({ orgId: "org-1", brandId: "brand-1", offerId: OFFER, campaignId: "camp-1" });
    expect(mockGenerateFromTemplate.mock.calls[0][0].giveLists).toEqual(lists);
  });

  it("reads nothing when the run names no offer", async () => {
    const { offerId: _drop, ...noOffer } = body;
    await request(app).post("/generate").send(noOffer).expect(200);
    expect(mockFetchGiveLists).not.toHaveBeenCalled();
    expect(mockGenerateFromTemplate.mock.calls[0][0].giveLists).toBeNull();
  });

  it("reads nothing for a multi-brand request (an offer belongs to one brand)", async () => {
    await request(app).post("/generate").send({ ...body, brandIds: ["brand-1", "brand-2"] }).expect(200);
    expect(mockFetchGiveLists).not.toHaveBeenCalled();
  });

  it("writes as before when brand-service cannot answer, instead of failing the run", async () => {
    mockFetchGiveLists.mockRejectedValue(new Error("brand-service user-fields read failed: 500 - boom"));
    await request(app).post("/generate").send(body).expect(200);
    expect(mockGenerateFromTemplate.mock.calls[0][0].giveLists).toBeNull();
  });

  it("answers a retried lead from storage without reading the lists", async () => {
    mockGenFindFirst.mockResolvedValue({ id: "gen-existing", subject: "stored", sequence: [], tokensInput: 1, tokensOutput: 1 });
    await request(app).post("/generate").send({ ...body, leadId: "lead-1" }).expect(200);
    expect(mockFetchGiveLists).not.toHaveBeenCalled();
    expect(mockGenerateFromTemplate).not.toHaveBeenCalled();
  });
});
