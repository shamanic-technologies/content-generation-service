import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// FACTORY-P3 fleet writer: /generate/materials hands the script writer exactly what /generate would have built the
// completion from, and /generate + `written` stores exactly the row /generate would have stored for that completion
// (the script's run as generation_run_id, no completion of its own, no run of its own). The old path runs for real
// here (chat-service-client NOT mocked), so the comparison is against what production stores today.

const mockCreateRun = vi.fn().mockResolvedValue({ id: "gen-run-1" });
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  updateRun: vi.fn().mockResolvedValue({}),
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

const mockValues = vi.fn();
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
      emailGenerations: { findFirst: (...a: unknown[]) => mockGenFindFirst(...a), findMany: vi.fn() },
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
  getCampaignFeatureInputs: vi.fn().mockResolvedValue({ targetGeo: "France" }),
}));
vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("../../src/lib/lead-client.js", () => ({
  getLeadBusinessLanguages: vi.fn().mockResolvedValue(["de"]),
}));
vi.mock("../../src/lib/offer-give-lists-client.js", () => ({
  fetchOfferGiveLists: vi.fn().mockResolvedValue({ giveForFree: ["A free audit"], neverGive: ["Discounts"] }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function completion(emails: Array<{ body: string; daysSinceLastStep?: number }>) {
  const json = { subject: "Hallo", emails };
  return new Response(
    JSON.stringify({ content: JSON.stringify(json), json, tokensInput: 900, tokensOutput: 120, model: "claude-sonnet-4-6" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const OFFER = "9a1b2c3d-0000-4000-8000-000000000001";
const body = {
  type: "cold-email-v75",
  variables: { leadFirstName: "Marie", clientCompanyName: "Acme" },
  campaignId: "camp-1",
  brandIds: ["brand-1"],
  offerId: OFFER,
  leadId: "lead-1",
  model: "claude-sonnet",
  brief: "Ask ONE open question.",
};

const completeCalls = () => mockFetch.mock.calls.filter(([url]) => String(url).endsWith("/complete"));

describe("POST /generate/materials + /generate with written (script writer)", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGenFindFirst.mockResolvedValue(null);
    mockPromptFindFirst.mockResolvedValue({
      id: "p-1",
      type: "cold-email-v75",
      prompt: "Write to {{leadFirstName}} for {{clientCompanyName}}.",
      variables: ["leadFirstName", "clientCompanyName"],
    });
    mockValues.mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "gen-1" }]) });
    mockFetch.mockImplementation(async (url: string) =>
      String(url).endsWith("/complete") ? completion([{ body: "Hallo Marie", daysSinceLastStep: 0 }]) : new Response("{}", { status: 200 }),
    );
    app = express();
    app.use(express.json());
    const { default: routes } = await import("../../src/routes/generate.js");
    app.use(routes);
  });

  async function servicePathRow() {
    await request(app).post("/generate").send(body).expect(200);
    const row = mockValues.mock.calls[0][0];
    vi.clearAllMocks();
    mockValues.mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "gen-2" }]) });
    mockGenFindFirst.mockResolvedValue(null);
    return row;
  }

  it("materials = what /generate builds the completion from, split as the script's proven cases", async () => {
    const row = await servicePathRow();
    const m = (await request(app).post("/generate/materials").send(body).expect(200)).body;
    expect(completeCalls()).toHaveLength(0);
    expect(mockValues).not.toHaveBeenCalled();
    expect(m.existing).toBeNull();
    expect(m.subject).toEqual({ service: "lead-service", id: "lead-1" });
    expect(m.tactics).toEqual({ llm: { provider: row.chatRequest.provider, model: row.chatRequest.model } });
    expect(m.units).toEqual({
      lead_identified: { content: { variables: { leadFirstName: "Marie" }, language: "German" } },
      brand_context: {
        content: {
          variables: { clientCompanyName: "Acme" },
          campaignContext: row.chatRequestInputs.campaignContext,
          giveLists: row.chatRequestInputs.giveLists,
          instruction: row.chatRequestInputs.instruction,
        },
      },
      template_written: { content: { text: row.chatRequestInputs.promptTemplate } },
    });
  });

  it("materials hand the script the campaign's brief, under the key the script reads (ONE-BRIEF-1105)", async () => {
    const brief = "Name the price: $25,000 for 30 days.";
    const m = (await request(app).post("/generate/materials").send({ ...body, brief }).expect(200)).body;
    expect(m.units.brand_context.content.instruction).toBe(brief);
  });

  it("written: stores the row /generate stores, on the script's run, with no completion and no run of its own", async () => {
    const row = await servicePathRow();
    const m = (await request(app).post("/generate/materials").send(body).expect(200)).body;
    const written = {
      status: "made",
      runId: "script-run-1",
      unit: { content: { subject: row.subject, sequence: row.sequence } },
      trace: [
        { name: "voice.read", answer: { ok: true, data: { content: row.chatRequestInputs.clientCommsVoice, version: null } } },
        { name: "llm.complete", sent: row.chatRequest, raw: row.responseRaw },
      ],
    };
    const res = await request(app).post("/generate").send({ ...body, written, units: m.units }).expect(200);
    expect(completeCalls()).toHaveLength(0);
    expect(mockCreateRun).not.toHaveBeenCalled();
    const recorded = mockValues.mock.calls[0][0];
    expect(recorded).toEqual({ ...row, generationRunId: "script-run-1" });
    expect(recorded.outcomes?.produced).toEqual([{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-1" }]);
    expect(res.body).toEqual({ id: "gen-2", subject: row.subject, sequence: row.sequence, tokensInput: row.tokensInput, tokensOutput: row.tokensOutput });
  });

  it("written: a script answer with follow-ups is stored and served as its first email only (FOLLOWUP-JIT-1107)", async () => {
    const row = await servicePathRow();
    const m = (await request(app).post("/generate/materials").send(body).expect(200)).body;
    const first = { step: 1, bodyHtml: "<p>Hallo Marie</p>", bodyText: "Hallo Marie", daysSinceLastStep: 0 };
    const written = {
      status: "made",
      runId: "script-run-1",
      unit: {
        content: {
          subject: row.subject,
          sequence: [first, { step: 2, bodyHtml: "<p>b</p>", bodyText: "b", daysSinceLastStep: 3 }, { step: 3, bodyHtml: "<p>c</p>", bodyText: "c", daysSinceLastStep: 7 }],
        },
      },
      trace: [
        { name: "voice.read", answer: { ok: true, data: { content: row.chatRequestInputs.clientCommsVoice, version: null } } },
        { name: "llm.complete", sent: row.chatRequest, raw: row.responseRaw },
      ],
    };
    const res = await request(app).post("/generate").send({ ...body, written, units: m.units }).expect(200);
    expect(mockValues.mock.calls[0][0].sequence).toEqual([first]);
    expect(res.body.sequence).toEqual([first]);
  });

  it("a request already answered: materials says so and /generate returns the stored email, writing nothing", async () => {
    const stored = { id: "gen-old", subject: "Old", sequence: [{ step: 1, bodyHtml: "<p>x</p>", bodyText: "x", daysSinceLastStep: 0 }], tokensInput: 5, tokensOutput: 6 };
    mockGenFindFirst.mockResolvedValue(stored);
    const m = (await request(app).post("/generate/materials").send(body).expect(200)).body;
    expect(m).toEqual({ existing: stored, subject: null, units: null, tactics: null });
    // The skipped script step answers null: /generate still returns the stored email.
    const res = await request(app).post("/generate").send({ ...body, written: null, units: null }).expect(200);
    expect(res.body).toEqual(stored);
    expect(mockValues).not.toHaveBeenCalled();
    expect(completeCalls()).toHaveLength(0);
  });

  it("a script run that made nothing is refused (400), nothing stored", async () => {
    const m = (await request(app).post("/generate/materials").send(body).expect(200)).body;
    const res = await request(app).post("/generate").send({ ...body, written: { status: "failed", runId: "r" }, units: m.units }).expect(400);
    expect(res.body.code).toBe("WRITTEN_BY_SCRIPT_UNREADABLE");
    expect(mockValues).not.toHaveBeenCalled();
  });

  describe("a signed-out preview (ONE-WRITER-N-MODELS-1116-CG-PREVIEW)", () => {
    // What /preview-email hands the writer it runs: our request minus template + model, no lead, marked `preview`.
    const { campaignId: _c, leadId: _l, model: _m, brief: _b, ...previewBase } = body;
    const preview = { key: "pk-1", campaignContext: { audience: "Heads of sales" }, giveLists: { giveForFree: ["A free teardown"], neverGive: ["Discounts"] } };

    it("materials answer a preview with no lead: no lookup, no language, the given context and lists, nothing stored or spent", async () => {
      const { getCampaignFeatureInputs } = await import("../../src/lib/campaign-client.js");
      const { getLeadBusinessLanguages } = await import("../../src/lib/lead-client.js");
      const { fetchOfferGiveLists } = await import("../../src/lib/offer-give-lists-client.js");
      const m = (await request(app).post("/generate/materials").send({ ...previewBase, preview }).expect(200)).body;
      expect(m).toEqual({
        existing: null,
        subject: { service: "content-generation-service", id: "preview:pk-1" },
        units: {
          lead_identified: { content: { variables: { leadFirstName: "Marie" } } },
          brand_context: { content: { variables: { clientCompanyName: "Acme" }, campaignContext: preview.campaignContext, giveLists: preview.giveLists } },
          template_written: { content: { text: "Write to {{leadFirstName}} for {{clientCompanyName}}." } },
        },
        tactics: null,
      });
      expect(mockGenFindFirst).not.toHaveBeenCalled();
      expect(getCampaignFeatureInputs).not.toHaveBeenCalled();
      expect(getLeadBusinessLanguages).not.toHaveBeenCalled();
      expect(fetchOfferGiveLists).not.toHaveBeenCalled();
      expect(mockValues).not.toHaveBeenCalled();
      expect(completeCalls()).toHaveLength(0);
    });

    it("a preview naming a lead, a campaign or an idempotency key is refused (400), nothing read", async () => {
      for (const extra of [{ leadId: "lead-1" }, { campaignId: "camp-1" }, { idempotencyKey: "k" }]) {
        const res = await request(app).post("/generate/materials").send({ ...previewBase, ...extra, preview }).expect(400);
        expect(res.body.code).toBe("PREVIEW_WITH_LEAD");
      }
      expect(mockPromptFindFirst).not.toHaveBeenCalled();
    });

    it("/generate never stores a preview (400 PREVIEW_NOT_STORABLE)", async () => {
      const res = await request(app).post("/generate").send({ ...previewBase, preview }).expect(400);
      expect(res.body.code).toBe("PREVIEW_NOT_STORABLE");
      expect(mockValues).not.toHaveBeenCalled();
      expect(completeCalls()).toHaveLength(0);
    });

    it("a campaign's materials (with a lead) answer exactly as before a preview existed", async () => {
      const m1 = (await request(app).post("/generate/materials").send(body).expect(200)).body;
      const m2 = (await request(app).post("/generate/materials").send({ ...body, preview: undefined }).expect(200)).body;
      expect(m2).toEqual(m1);
      expect(m1.subject).toEqual({ service: "lead-service", id: "lead-1" });
      expect(m1.tactics).toEqual({ llm: { provider: expect.any(String), model: "claude-sonnet" } });
    });
  });

  it("materials refuses a request with no lead (the script declares on the person's lead)", async () => {
    const { leadId: _l, ...noLead } = body;
    await request(app).post("/generate/materials").send(noLead).expect(400);
  });
});
