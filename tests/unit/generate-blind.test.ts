import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// BLIND-WRITER-REVERT-1017 (owner 2026-10-17: « We dont want to spend extra money!!! The
// template instructions should be enough, we are ok with some NOISE »): a blind-type email
// is written like any other, one completion from the template's own text. No brand read,
// no anonymity rule, no check, no rewrite. The guarantee is the template, checked at SAVE.

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

const mockExtractBrandFields = vi.fn();
// Only the brand-fields read the template asks for: any other brand-client export used by
// the route would be undefined here and fail the test.
vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: (...a: unknown[]) => mockExtractBrandFields(...a),
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

describe("POST /generate — a blind template is written like any other", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockPromptFindFirst.mockImplementation(async () => ({ id: "p", type: "t", prompt: "Write.", variables: [] }));
    mockValues.mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "gen-1" }]) });
    mockExtractBrandFields.mockResolvedValue(new Map());
    mockGenerate.mockResolvedValue({ subject: "s", sequence: [], tokensInput: 1, tokensOutput: 1, model: "m", promptRaw: "p", responseRaw: {} });
    app = express();
    app.use(express.json());
    const { default: routes } = await import("../../src/routes/generate.js");
    app.use(routes);
  });

  it("makes one writing call, with no anonymity parameter and no brand read, for every blind version", async () => {
    for (const type of ["blind-discovery-email-v34", "blind-discovery-email-v47", "feedback-request-blind-email-v1"]) {
      mockGenerate.mockClear();
      await request(app).post("/generate").send(body(type)).expect(200);
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      const params = mockGenerate.mock.calls[0][0];
      expect(params).not.toHaveProperty("blind");
      expect(params).not.toHaveProperty("onBlindRewrite");
    }
    // The template asks for no brand field: nothing is read from brand-service.
    expect(mockExtractBrandFields).not.toHaveBeenCalled();
  });

  it("sends a blind and a named template the same writing parameters", async () => {
    await request(app).post("/generate").send(body("blind-discovery-email-v34")).expect(200);
    await request(app).post("/generate").send(body("cold-email-v49")).expect(200);
    expect(Object.keys(mockGenerate.mock.calls[0][0]).sort()).toEqual(Object.keys(mockGenerate.mock.calls[1][0]).sort());
  });
});

describe("generateFromTemplate — a blind-type answer is served as written", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  it("makes exactly one completion even when the answer names the client", async () => {
    const { generateFromTemplate } = await vi.importActual<typeof import("../../src/lib/chat-service-client")>(
      "../../src/lib/chat-service-client"
    );
    const json = { subject: "Living Vital for your clinic", emails: [{ body: "Hi Ann,\n\nWir von Living Vital...", daysSinceLastStep: 0 }] };
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ content: "", json, tokensInput: 10, tokensOutput: 10, model: "gemini" }) });
    const result = await generateFromTemplate(
      { promptTemplate: "Blind email. {{brandExtractedFields}}", variables: { brandExtractedFields: "Living Vital (livingvital.ch)" }, model: "pro" },
      { orgId: "org-1", userId: "user-1", runId: "run-1" }
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).systemPrompt).not.toMatch(/anonymous/);
    expect(result.subject).toBe("Living Vital for your clinic");
  });
});
