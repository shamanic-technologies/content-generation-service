import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// A blind email is ONE completion from the template's text, never checked or rewritten after
// (BLIND-WRITER-REVERT-1017, owner: « we are ok with some NOISE »). What the writer SEES is fixed instead
// (BLIND-NAME-LEAK-1105): for a template of a BLIND dynasty, the client's name, domain and URLs are
// masked in every input; a NAMED dynasty's writer reads them untouched, whatever its type name says.

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
const mockFetchClientIdentities = vi.fn();
vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: (...a: unknown[]) => mockExtractBrandFields(...a),
  fetchClientIdentities: (...a: unknown[]) => mockFetchClientIdentities(...a),
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

const INTEL = {
  clientName: "Shockwave Centers of America",
  brandExtractedFields: { valueProposition: { value: "Shockwave Centers of America places devices in 300+ clinics, $0 upfront (shockwavecenters.com/learnmore)." } },
  leadFirstName: "Ann",
  leadCompanyName: "Ann's Clinic",
};
const body = (type: string, variables: Record<string, unknown> = INTEL) => ({ type, variables: structuredClone(variables), campaignId: "camp-1", brandIds: ["brand-1"], leadId: "lead-1" });

// The dynasty's identity, never the type name: `blind-discovery-email-v50` heads a NAMED dynasty.
const IDENTITY: Record<string, "blind" | "named"> = {
  "blind-discovery-email-v21-no-url-spaced-v2": "blind",
  "acquisition-questions-email-v1": "blind",
  "blind-discovery-email-v50": "named",
  "cold-email-v77": "named",
};

describe("POST /generate — a blind dynasty's writer never sees who the client is", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { dynastyIdentityOf } = await import("../../src/lib/dynasty-membership.js");
    (dynastyIdentityOf as any).mockImplementation(async (type: string) => IDENTITY[type] ?? null);
    mockPromptFindFirst.mockImplementation(async () => ({ id: "p", type: "t", prompt: "Write. {{brandExtractedFields}}", variables: [] }));
    mockValues.mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "gen-1" }]) });
    mockExtractBrandFields.mockResolvedValue(new Map());
    mockFetchClientIdentities.mockResolvedValue([{ id: "brand-1", name: "Shockwave Centers of America", domain: "shockwavecenters.com", url: "https://shockwavecenters.com/learnmore" }]);
    mockGenerate.mockResolvedValue({ subject: "s", sequence: [], tokensInput: 1, tokensOutput: 1, model: "m", promptRaw: "p", responseRaw: {} });
    app = express();
    app.use(express.json());
    const { default: routes } = await import("../../src/routes/generate.js");
    app.use(routes);
  });

  it("masks the client's name and website in what a blind writer reads, keeps the selling points, makes one writing call", async () => {
    for (const type of ["blind-discovery-email-v21-no-url-spaced-v2", "acquisition-questions-email-v1"]) {
      mockGenerate.mockClear();
      mockValues.mockClear();
      await request(app).post("/generate").send(body(type)).expect(200);
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      const params = mockGenerate.mock.calls[0][0];
      const seen = JSON.stringify(params.variables);
      expect(seen).not.toMatch(/shockwave ?centers/i);
      expect(seen).toContain("places devices in 300+ clinics, $0 upfront (the client's website).");
      expect(params.variables.leadCompanyName).toBe("Ann's Clinic");
      expect(params).not.toHaveProperty("blind");
      // The row stores what the writer read; its columns keep the request's values.
      const row = mockValues.mock.calls[0][0];
      expect(JSON.stringify(row.variablesRaw)).not.toMatch(/shockwave ?centers/i);
    }
    expect(mockFetchClientIdentities).toHaveBeenCalledWith(["brand-1"], expect.anything());
  });

  it("hands a NAMED dynasty's writer the client's name, even when its type starts with blind-discovery-email", async () => {
    for (const type of ["blind-discovery-email-v50", "cold-email-v77"]) {
      mockGenerate.mockClear();
      await request(app).post("/generate").send(body(type)).expect(200);
      expect(mockGenerate.mock.calls[0][0].variables.clientName).toBe("Shockwave Centers of America");
    }
    expect(mockFetchClientIdentities).not.toHaveBeenCalled();
  });

  it("masks the script writer's materials the same way", async () => {
    const res = await request(app).post("/generate/materials").send(body("blind-discovery-email-v21-no-url-spaced-v2")).expect(200);
    expect(JSON.stringify(res.body.units)).not.toMatch(/shockwave ?centers/i);
    expect(res.body.units.brand_context.content.variables.clientName).toBe("the client");
    expect(res.body.units.lead_identified.content.variables.leadFirstName).toBe("Ann");
  });

  it("refuses to write a blind email when brand-service cannot say who the client is: nothing written", async () => {
    const { ClientIdentityError } = await import("../../src/lib/client-identity-mask.js");
    mockFetchClientIdentities.mockRejectedValue(new ClientIdentityError(502, "brand-service GET /internal/brands failed: 503"));
    const res = await request(app).post("/generate").send(body("blind-discovery-email-v21-no-url-spaced-v2")).expect(502);
    expect(res.body.code).toBe("CLIENT_IDENTITY_UNREADABLE");
    expect(mockGenerate).not.toHaveBeenCalled();
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
