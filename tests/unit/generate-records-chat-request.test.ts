import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// FACTORY-P3-RECORD-SYSTEM-PROMPT: the request /generate sends to chat-service /complete is stored on
// the generation row, byte for byte what was sent. chat-service-client is NOT mocked here: the real
// generateFromTemplate builds and sends the request, fetch captures it, the db mock captures the row.

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "gen-run-1" }),
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

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: (...a: unknown[]) => mockValues(...a) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
    query: {
      prompts: { findFirst: (...a: unknown[]) => mockPromptFindFirst(...a) },
      emailGenerations: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() },
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

describe("POST /generate records the exact chat-service request", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
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

  it("stores the body sent to /complete, equal to what was sent, with the inputs it was built from", async () => {
    await request(app).post("/generate").send(body).expect(200);

    expect(completeCalls()).toHaveLength(1);
    const sent = JSON.parse(completeCalls()[0][1].body as string);
    const row = mockValues.mock.calls[0][0];

    expect(row.chatRequest).toEqual(sent);
    // Every part of the system prompt is in what is stored, since it is what was sent.
    expect(Object.keys(row.chatRequest).sort()).toEqual(["message", "model", "provider", "responseSchema", "systemPrompt"]);
    expect(row.chatRequest.systemPrompt).toContain("TEST VOICE");
    expect(row.chatRequest.systemPrompt).toContain("German");
    expect(row.chatRequest.systemPrompt).toContain("A free audit");
    expect(row.chatRequest.systemPrompt).toContain("Ask ONE open question.");
    expect(row.chatRequest.message).toContain("Write to Marie for Acme.");
    expect(row.chatRequest.message).toBe(row.promptRaw);
    expect(row.chatRequest.model).toBe("claude-sonnet");

    expect(row.chatRequestInputs).toEqual({
      promptTemplate: "Write to {{leadFirstName}} for {{clientCompanyName}}.",
      campaignContext: { targetGeo: "France" },
      language: "German",
      giveLists: { giveForFree: ["A free audit"], neverGive: ["Discounts"] },
      instruction: "Ask ONE open question.",
      clientCommsVoice: "TEST VOICE: answer first, short, plain words.",
    });
  });

  it("stores the one request a regeneration re-sent", async () => {
    let n = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (!String(url).endsWith("/complete")) return new Response("{}", { status: 200 });
      n++;
      // First answer: a follow-up with no delay (unusable) -> regenerated once.
      return n === 1
        ? completion([{ body: "a", daysSinceLastStep: 0 }, { body: "b" }])
        : completion([{ body: "Hallo Marie", daysSinceLastStep: 0 }]);
    });
    await request(app).post("/generate").send(body).expect(200);

    const calls = completeCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1][1].body).toBe(calls[0][1].body);
    expect(mockValues.mock.calls[0][0].chatRequest).toEqual(JSON.parse(calls[0][1].body as string));
  });
});
