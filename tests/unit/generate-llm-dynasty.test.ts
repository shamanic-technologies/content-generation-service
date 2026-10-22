import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// LLM-DYNASTY-1022-CG: a workflow names an LLM by its dynasty slug (`claude-opus`), which
// chat-service runs on the dynasty's newest version. Accepted names are chat-service's own
// catalogue (stubbed in tests/setup.ts), never a list kept here; legacy aliases keep working.

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

const body = (model?: string) => ({ type: "cold-email-v49", variables: {}, campaignId: "camp-1", brandIds: ["brand-1"], ...(model ? { model } : {}) });

describe("POST /generate — the LLM is named by its dynasty", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockPromptFindFirst.mockImplementation(async () => ({ id: "p", type: "cold-email-v49", prompt: "Write.", variables: [] }));
    mockValues.mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "gen-1" }]) });
    mockExtractBrandFields.mockResolvedValue(new Map());
    mockGenerate.mockResolvedValue({ subject: "s", sequence: [], tokensInput: 1, tokensOutput: 1, model: "claude-opus-5-5", promptRaw: "p", responseRaw: {} });
    app = express();
    app.use(express.json());
    const { default: routes } = await import("../../src/routes/generate.js");
    app.use(routes);
  });

  it("writes with every served dynasty slug, passed to chat-service as named", async () => {
    for (const slug of ["claude-opus", "claude-haiku", "claude-sonnet", "claude-fable", "gemini-flash-lite", "gemini-flash", "gemini-pro", "deepseek-flash", "glm-flash", "glm", "kimi-k2", "kimi-k3", "gpt-astra", "gpt-sol", "gpt-terra"]) {
      mockGenerate.mockClear();
      await request(app).post("/generate").send(body(slug)).expect(200);
      expect(mockGenerate.mock.calls[0][0].model, slug).toBe(slug);
    }
  });

  it("records the model that actually wrote, not the name that called it", async () => {
    await request(app).post("/generate").send(body("claude-opus")).expect(200);
    expect(mockValues.mock.calls[0][0].model).toBe("claude-opus-5-5");
  });

  it("keeps a legacy alias working unchanged", async () => {
    await request(app).post("/generate").send(body("opus")).expect(200);
    expect(mockGenerate.mock.calls[0][0].model).toBe("opus");
  });

  it("refuses a name chat-service does not accept, before reading or writing anything", async () => {
    const res = await request(app).post("/generate").send(body("claude_opus")).expect(400);
    expect(res.body.code).toBe("UNKNOWN_MODEL");
    expect(res.body.accepted).toContain("claude-opus");
    expect(mockPromptFindFirst).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

describe("generateFromTemplate — a dynasty slug reaches /complete on its provider", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  const json = { subject: "Hi", emails: [{ body: "Hello", daysSinceLastStep: 0 }] };
  const ok = (model: string) => ({ ok: true, status: 200, json: () => Promise.resolve({ content: "", json, tokensInput: 1, tokensOutput: 1, model }) });

  it("claude-opus → provider anthropic with the strict schema; gemini-flash → google, permissive", async () => {
    const { generateFromTemplate } = await vi.importActual<typeof import("../../src/lib/chat-service-client")>(
      "../../src/lib/chat-service-client"
    );
    const identity = { orgId: "org-1", userId: "user-1", runId: "run-1" };
    mockFetch.mockResolvedValueOnce(ok("claude-opus-5-5"));
    const r = await generateFromTemplate({ promptTemplate: "Write.", variables: {}, model: "claude-opus" }, identity);
    const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sent).toMatchObject({ provider: "anthropic", model: "claude-opus" });
    expect(sent.responseSchema.additionalProperties).toBe(false);
    expect(r.model).toBe("claude-opus-5-5");

    mockFetch.mockResolvedValueOnce(ok("gemini-3.8-flash"));
    await generateFromTemplate({ promptTemplate: "Write.", variables: {}, model: "gemini-flash" }, identity);
    const sent2 = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(sent2).toMatchObject({ provider: "google", model: "gemini-flash" });
    expect(sent2.responseSchema.additionalProperties).toBeUndefined();
  });
});
