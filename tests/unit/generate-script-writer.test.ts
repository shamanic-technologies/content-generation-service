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
  instruction: "Ask ONE open question.",
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

  it("materials refuses a request with no lead (the script declares on the person's lead)", async () => {
    const { leadId: _l, ...noLead } = body;
    await request(app).post("/generate/materials").send(noLead).expect(400);
  });
});
