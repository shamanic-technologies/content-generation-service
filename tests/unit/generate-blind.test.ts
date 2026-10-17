import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { BlindClientNamedError } from "../../src/lib/blind-template";

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-456" }),
  updateRun: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "org-1";
    req.userId = "user-1";
    req.runId = "run-1";
    next();
  },
}));

const mockPromptFindFirst = vi.fn();
const mockValues = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: (...a: unknown[]) => mockValues(...a) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    query: {
      prompts: { findFirst: (...a: unknown[]) => mockPromptFindFirst(...a) },
      emailGenerations: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailGenerations: { id: {}, orgId: {}, idempotencyKey: {}, leadId: {}, campaignId: {}, brandIds: {}, createdAt: {} },
  prompts: { orgId: {}, type: {} },
}));

vi.mock("../../src/lib/campaign-client.js", () => ({ getCampaignFeatureInputs: vi.fn().mockResolvedValue(null) }));
vi.mock("../../src/lib/lead-client.js", () => ({ getLeadBusinessLanguages: vi.fn().mockResolvedValue(null) }));
vi.mock("../../src/lib/offer-give-lists-client.js", () => ({ fetchOfferGiveLists: vi.fn().mockResolvedValue(null) }));

const mockBrandRows = vi.fn();
vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn().mockResolvedValue(new Map()),
  fetchBrandIdentityRows: (...a: unknown[]) => mockBrandRows(...a),
}));

const mockGenerate = vi.fn();
vi.mock("../../src/lib/chat-service-client.js", () => ({
  generateFromTemplate: (...a: unknown[]) => mockGenerate(...a),
  substituteVariables: (t: string) => t,
  findUnfilledPlaceholders: () => [],
  InsufficientCreditsError: class extends Error {},
  ExpertQuotePitchLengthError: class extends Error {},
  generateExpertQuotePitchFromTemplate: vi.fn(),
}));

const body = (type: string, variables: Record<string, unknown> = {}) => ({ type, variables, campaignId: "camp-1", brandIds: ["brand-1"] });

describe("POST /generate — blind templates keep the client anonymous", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockPromptFindFirst.mockImplementation(async () => ({ id: "p", type: "t", prompt: "Write.", variables: [] }));
    mockValues.mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "gen-1" }]) });
    mockBrandRows.mockResolvedValue([{ id: "brand-1", name: "Doc Dinners", domain: "docdinners.com", url: "https://docdinners.com" }]);
    mockGenerate.mockResolvedValue({ subject: "s", sequence: [], tokensInput: 1, tokensOutput: 1, model: "m", promptRaw: "p", responseRaw: {} });
    app = express();
    app.use(express.json());
    const { default: routes } = await import("../../src/routes/generate.js");
    app.use(routes);
  });

  it("hands the writer the brand's name and domain to keep out, for every blind version", async () => {
    for (const type of ["blind-discovery-email-v34", "blind-discovery-email-v15", "feedback-request-blind-email-v1"]) {
      mockGenerate.mockClear();
      await request(app).post("/generate").send(body(type)).expect(200);
      expect(mockGenerate.mock.calls[0][0].blind).toEqual({ names: ["Doc Dinners", "DocDinners"], domains: ["docdinners.com"] });
    }
    expect(mockBrandRows.mock.calls[0][0]).toEqual(["brand-1"]);
  });

  it("leaves named and offer templates untouched", async () => {
    await request(app).post("/generate").send(body("cold-email-v49")).expect(200);
    expect(mockBrandRows).not.toHaveBeenCalled();
    expect(mockGenerate.mock.calls[0][0].blind).toBeNull();
  });

  it("does not hide the brand from someone who already knows it (warm re-engagement)", async () => {
    await request(app)
      .post("/generate")
      .send(body("blind-discovery-email-v34", { leadRelationship: { state: "not_known", tags: ["prospect"] } }))
      .expect(200);
    expect(mockGenerate.mock.calls[0][0].blind).toBeNull();
  });

  it("refuses to write when the brand cannot be read (502, nothing billed)", async () => {
    mockBrandRows.mockRejectedValue(new Error("brand-service GET /internal/brands failed: 503 - down"));
    const res = await request(app).post("/generate").send(body("blind-discovery-email-v34")).expect(502);
    expect(res.body.code).toBe("BLIND_BRAND_UNREADABLE");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("answers 502 and stores nothing when the email still names the client", async () => {
    mockGenerate.mockRejectedValue(new BlindClientNamedError([{ where: "subject", terms: ["Doc Dinners"] }], 3));
    const res = await request(app).post("/generate").send(body("blind-discovery-email-v34")).expect(502);
    expect(res.body.code).toBe("BLIND_CLIENT_NAMED");
    expect(mockValues).not.toHaveBeenCalled();
  });
});
