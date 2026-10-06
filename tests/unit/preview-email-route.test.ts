import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// POST /preview-email writes ONE cold email for a brand + a sample recipient, before any
// campaign exists. These tests pin: the best mature workflow's template + model + brand-intel
// request are used (no hardcoded template/model, no fallback when the ranking is unreadable),
// the spend goes through chat-service under the calling org, a refusal to pay is a clean
// 402, a repeat is answered from storage with no downstream call, and nothing is written
// to email_generations.

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "11111111-1111-1111-1111-111111111111";
    req.userId = req.headers["x-user-id"] || "user-1";
    req.runId = req.headers["x-run-id"] || "run-1";
    next();
  },
}));

const { EMAIL_PREVIEWS, EMAIL_GENERATIONS } = vi.hoisted(() => ({
  EMAIL_PREVIEWS: { __table: "email_previews", orgId: {}, brandId: {}, recipientKey: {} },
  EMAIL_GENERATIONS: { __table: "email_generations" },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailPreviews: EMAIL_PREVIEWS,
  emailGenerations: EMAIL_GENERATIONS,
  prompts: { type: {} },
}));

const mockPreviewFindFirst = vi.fn();
const mockPromptFindFirst = vi.fn();
const mockReturning = vi.fn();
const mockValues = vi.fn().mockReturnValue({ returning: (...a: unknown[]) => mockReturning(...a) });
const mockInsert = vi.fn().mockReturnValue({ values: (...a: unknown[]) => mockValues(...a) });

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (...a: unknown[]) => mockInsert(...a),
    query: {
      emailPreviews: { findFirst: (...a: unknown[]) => mockPreviewFindFirst(...a) },
      prompts: { findFirst: (...a: unknown[]) => mockPromptFindFirst(...a) },
    },
  },
}));

const mockFetchBrandIntel = vi.fn();
const mockFetchBrandRows = vi.fn();
vi.mock("../../src/lib/brand-client.js", () => {
  class BrandIntelError extends Error {
    constructor(public status: number, public body: string) {
      super(`brand-service extract-fields failed: ${status} - ${body}`);
    }
  }
  class BrandRowsError extends Error {
    constructor(public status: number, public body: string) {
      super(`brand-service GET /internal/brands failed: ${status} - ${body}`);
    }
  }
  return {
    BrandIntelError,
    BrandRowsError,
    fetchBrandIntel: (...a: unknown[]) => mockFetchBrandIntel(...a),
    fetchBrandRows: (...a: unknown[]) => mockFetchBrandRows(...a),
  };
});

const mockResolvePreviewWorkflow = vi.fn();
vi.mock("../../src/lib/preview-workflow-client.js", () => ({
  resolvePreviewWorkflow: (...a: unknown[]) => mockResolvePreviewWorkflow(...a),
}));

const mockFetchGiveLists = vi.fn();
vi.mock("../../src/lib/offer-give-lists-client.js", () => {
  class OfferGiveListsError extends Error {
    constructor(public status: number, public body: string) {
      super(`brand-service user-fields read failed: ${status} - ${body}`);
    }
  }
  return {
    OfferGiveListsError,
    fetchOfferGiveLists: (...a: unknown[]) => mockFetchGiveLists(...a),
  };
});

const mockGenerate = vi.fn();
vi.mock("../../src/lib/chat-service-client.js", () => {
  class InsufficientCreditsError extends Error {
    constructor(public balance_cents: number, public required_cents: number) {
      super("Insufficient credits");
    }
  }
  return {
    InsufficientCreditsError,
    generateFromTemplate: (...a: unknown[]) => mockGenerate(...a),
  };
});

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

import previewRoutes from "../../src/routes/preview-email.js";
import { InsufficientCreditsError } from "../../src/lib/chat-service-client.js";
import { BrandIntelError } from "../../src/lib/brand-client.js";
import { OfferGiveListsError } from "../../src/lib/offer-give-lists-client.js";
import { PreviewWorkflowError, type PreviewPlan } from "../../src/lib/preview-workflow.js";

const app = express();
app.use(express.json());
app.use(previewRoutes);

const BRAND_ID = "5f0c7a2e-8b1d-4c3e-9a4f-6d2b1e0c9a77";
const BODY = {
  brandId: BRAND_ID,
  recipient: { firstName: "Jane", lastName: "Doe", title: "VP Sales", companyName: "Acme", companyDomain: "acme.com" },
  audience: "Heads of sales at US B2B SaaS companies",
};

const INTEL = {
  brands: [{ brandId: BRAND_ID, domain: "brand.io", name: "Brand Co", brandUrl: "https://brand.io" }],
  fields: { companyOverview: { value: "We do X", byBrand: {} } },
  provenance: {},
};

const TEMPLATE = "Today {{currentDate}}. Prospect {{leadFirstName}} {{leadLastName}}, {{leadTitle}} at {{leadCompanyName}} ({{leadCompanyIndustry}}). Client {{clientName}}. Intel {{brandExtractedFields}}. Brands {{brands}}. Page {{landingPageContent}}";

// The best mature workflow's plan, as resolvePreviewWorkflow reads it off the ranking + DAG.
// Deliberately NOT cold-email-v39 / sonnet: the route must use whatever the plan says.
const PLAN_FIELDS = [{ key: "companyOverview", description: "A comprehensive overview of the company" }];
const PLAN: PreviewPlan = {
  workflowSlug: "sales-cold-email-outreach-nobelium-v5",
  workflowDynastySlug: "sales-cold-email-outreach-nobelium",
  promptType: "blind-discovery-email-v33",
  model: "glm-pro",
  brandIntelFields: PLAN_FIELDS,
  sources: {
    currentDate: { kind: "current-date" },
    leadFirstName: { kind: "recipient", field: "firstName" },
    leadLastName: { kind: "recipient", field: "lastName" },
    leadTitle: { kind: "recipient", field: "title" },
    leadCompanyName: { kind: "recipient", field: "companyName" },
    leadCompanyIndustry: { kind: "recipient", field: "companyIndustry" },
    leadCompanyWebsiteUrl: { kind: "recipient", field: "companyDomain" },
    leadCity: { kind: "lead-unknown", path: "city" },
    clientName: { kind: "brand", path: "name" },
    brandExtractedFields: { kind: "brand-intel", part: "fields" },
    brands: { kind: "brands" },
  },
};
const BRAND_ROWS = [{ id: BRAND_ID, name: "Brand Co", domain: "brand.io", clickDestinationUrl: "https://brand.io/start" }];

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    orgId: "11111111-1111-1111-1111-111111111111",
    brandId: BRAND_ID,
    brandName: "Brand Co",
    runId: "run-0",
    recipientKey: "k",
    recipient: BODY.recipient,
    promptType: PLAN.promptType,
    subject: "Quick question",
    bodyText: "Hi Jane,\n\nHello.",
    bodyHtml: "<p>Hi Jane,</p><p>Hello.</p>",
    sequence: [],
    model: "gemini-3.1-pro-preview",
    createdAt: new Date("2026-09-28T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPreviewFindFirst.mockResolvedValue(undefined);
  mockPromptFindFirst.mockResolvedValue({ type: PLAN.promptType, prompt: TEMPLATE });
  mockResolvePreviewWorkflow.mockResolvedValue(PLAN);
  mockFetchBrandRows.mockResolvedValue(BRAND_ROWS);
  mockFetchBrandIntel.mockResolvedValue(INTEL);
  mockFetchGiveLists.mockResolvedValue({ giveForFree: [], neverGive: [] });
  mockGenerate.mockResolvedValue({
    subject: "Quick question",
    sequence: [
      { step: 1, bodyText: "Hi Jane,\n\nHello.", bodyHtml: "<p>Hi Jane,</p><p>Hello.</p>", daysSinceLastStep: 0 },
      { step: 2, bodyText: "Following up.", bodyHtml: "<p>Following up.</p>", daysSinceLastStep: 3 },
    ],
    tokensInput: 100,
    tokensOutput: 50,
    model: "gemini-3.1-pro-preview",
    promptRaw: "p",
    responseRaw: {},
    highlights: [
      { text: "Hello.", source: "recipient.title", reason: "She runs sales." },
      { text: "Invented.", source: "recipient.title", reason: "not in the body" },
    ],
  });
  mockReturning.mockImplementation(async () => [storedRow({ runId: "run-1" })]);
});

describe("POST /preview-email", () => {
  it("writes with the best mature workflow's template, model, brand-intel request and input mapping", async () => {
    const res = await request(app).post("/preview-email").send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      brandId: BRAND_ID,
      brandName: "Brand Co",
      subject: "Quick question",
      bodyText: "Hi Jane,\n\nHello.",
      cached: false,
    });

    // The workflow is read at request time, under the caller's identity.
    expect(mockResolvePreviewWorkflow.mock.calls[0][0]).toMatchObject({ orgId: "11111111-1111-1111-1111-111111111111", runId: "run-1", brandId: BRAND_ID });

    // The workflow's own brand-extract-fields request, under the caller's org.
    const [fields, identity] = mockFetchBrandIntel.mock.calls[0];
    expect(fields).toEqual(PLAN_FIELDS);
    expect(identity).toMatchObject({ orgId: "11111111-1111-1111-1111-111111111111", userId: "user-1", runId: "run-1", brandId: BRAND_ID });
    expect(mockFetchBrandRows.mock.calls[0][0]).toBe(BRAND_ID);

    const [params, chatIdentity] = mockGenerate.mock.calls[0];
    expect(params.promptTemplate).toBe(TEMPLATE);
    expect(params.model).toBe("glm-pro");
    // No reasoning override: /generate sends none.
    expect("disableThinking" in params).toBe(false);
    expect(params.variables).toMatchObject({
      leadFirstName: "Jane",
      leadTitle: "VP Sales",
      leadCompanyName: "Acme",
      leadCompanyWebsiteUrl: "acme.com",
      clientName: "Brand Co",
      brandExtractedFields: INTEL.fields,
      brands: BRAND_ROWS,
      leadCompanyIndustry: "",
      // A template input the workflow maps from nothing a preview holds is empty, never invented.
      landingPageContent: "",
    });
    expect(params.variables.currentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A lead fact the sample recipient lacks and the template never asks for is absent.
    expect("leadCity" in params.variables).toBe(false);
    expect(params.campaignContext).toEqual({ audience: BODY.audience });
    expect(chatIdentity).toMatchObject({ orgId: "11111111-1111-1111-1111-111111111111", runId: "run-1", brandId: BRAND_ID });

    // The template is looked up by the workflow's type, not a constant.
    expect(mockPromptFindFirst).toHaveBeenCalledTimes(1);
  });

  it("records which workflow, template and model alias wrote the stored preview", async () => {
    mockReturning.mockImplementation(async () => [storedRow({ runId: "run-1", ...mockValues.mock.calls[0][0] })]);
    const res = await request(app).post("/preview-email").send(BODY);
    expect(mockValues.mock.calls[0][0]).toMatchObject({
      promptType: "blind-discovery-email-v33",
      modelAlias: "glm-pro",
      workflowSlug: "sales-cold-email-outreach-nobelium-v5",
    });
    expect(res.body).toMatchObject({ promptType: "blind-discovery-email-v33", modelAlias: "glm-pro", workflowSlug: "sales-cold-email-outreach-nobelium-v5" });
  });

  it("writes a new preview when the best workflow changes", async () => {
    await request(app).post("/preview-email").send(BODY);
    const first = mockValues.mock.calls[0][0].recipientKey;
    mockResolvePreviewWorkflow.mockResolvedValue({ ...PLAN, workflowSlug: "sales-cold-email-outreach-nobelium-v6" });
    await request(app).post("/preview-email").send(BODY);
    expect(mockValues.mock.calls[1][0].recipientKey).not.toBe(first);
    mockResolvePreviewWorkflow.mockResolvedValue({ ...PLAN, model: "deepseek-flash" });
    await request(app).post("/preview-email").send(BODY);
    expect(mockValues.mock.calls[2][0].recipientKey).not.toBe(first);
  });

  it("fails loud when the ranking cannot be read: no fallback template or model, nothing billed", async () => {
    mockResolvePreviewWorkflow.mockRejectedValue(new PreviewWorkflowError(503, "features-service has not computed the cold-email workflow ranking yet"));
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("ranking");
    expect(mockPromptFindFirst).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();

    mockResolvePreviewWorkflow.mockRejectedValue(new PreviewWorkflowError(502, "features-service leg-workflow-ranking failed: 500"));
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(502);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("refuses a caller-chosen model", async () => {
    const res = await request(app).post("/preview-email").send({ ...BODY, model: "sonnet" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("model");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("reads no brand rows when the workflow's template is not fed from them", async () => {
    const { brands: _b, clientName: _c, ...sources } = PLAN.sources;
    mockResolvePreviewWorkflow.mockResolvedValue({ ...PLAN, sources });
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(200);
    expect(mockFetchBrandRows).not.toHaveBeenCalled();
  });

  it("stores the preview in email_previews only — never in email_generations", async () => {
    await request(app).post("/preview-email").send(BODY);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0]).toBe(EMAIL_PREVIEWS);
    expect(mockValues.mock.calls[0][0]).toMatchObject({ bodyText: "Hi Jane,\n\nHello.", brandName: "Brand Co" });
  });

  it("answers a repeat from storage without brand intel or a completion", async () => {
    mockPreviewFindFirst.mockResolvedValue(storedRow());
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.subject).toBe("Quick question");
    expect(mockFetchBrandIntel).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("refuses an org that cannot afford the completion with a clean 402", async () => {
    mockGenerate.mockRejectedValue(new InsufficientCreditsError(5, 40));
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: "Insufficient credits", balance_cents: 5, required_cents: 40 });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("passes brand-service's verdict on the brand through (404 not found, 409 several offers)", async () => {
    mockFetchBrandIntel.mockRejectedValueOnce(new BrandIntelError(404, "Brand not found"));
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(404);
    mockFetchBrandIntel.mockRejectedValueOnce(new BrandIntelError(409, "SEVERAL_OFFERS"));
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(409);
    mockFetchBrandIntel.mockRejectedValueOnce(new BrandIntelError(500, "boom"));
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(502);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("writes with the offer's give lists: passed to the completion, and the free-give list is a highlight source", async () => {
    const lists = { giveForFree: ["A free pipeline audit"], neverGive: ["Discounts"] };
    mockFetchGiveLists.mockResolvedValue(lists);
    const res = await request(app).post("/preview-email").send({ ...BODY, offerId: "9a1b2c3d-0000-4000-8000-000000000001" });
    expect(res.status).toBe(200);

    const [identity] = mockFetchGiveLists.mock.calls[0];
    expect(identity).toMatchObject({ brandId: BRAND_ID, offerId: "9a1b2c3d-0000-4000-8000-000000000001" });

    const [params] = mockGenerate.mock.calls[0];
    expect(params.giveLists).toEqual(lists);
    const source = params.annotate.sources.find((s: { id: string }) => s.id === "offer.giveForFree");
    expect(source).toBeDefined();
    // The won't-give list is never something an email rests on.
    expect(params.annotate.sources.map((s: { id: string }) => s.id).join(" ")).not.toContain("neverGive");
  });

  it("offers no free-give highlight source when the lists are empty", async () => {
    await request(app).post("/preview-email").send(BODY);
    const [params] = mockGenerate.mock.calls[0];
    expect(params.giveLists).toEqual({ giveForFree: [], neverGive: [] });
    expect(params.annotate.sources.map((s: { id: string }) => s.id)).not.toContain("offer.giveForFree");
  });

  it("stores a different preview once the give lists change, and the same one while they are empty", async () => {
    await request(app).post("/preview-email").send(BODY);
    const emptyKey = mockValues.mock.calls[0][0].recipientKey;
    mockFetchGiveLists.mockResolvedValue({ giveForFree: ["A free audit"], neverGive: [] });
    await request(app).post("/preview-email").send(BODY);
    const listKey = mockValues.mock.calls[1][0].recipientKey;
    expect(listKey).not.toBe(emptyKey);
    mockFetchGiveLists.mockResolvedValue({ giveForFree: [], neverGive: [] });
    await request(app).post("/preview-email").send(BODY);
    expect(mockValues.mock.calls[2][0].recipientKey).toBe(emptyKey);
  });

  it("passes brand-service's verdict on the give-list read through, before any completion", async () => {
    mockFetchGiveLists.mockRejectedValueOnce(new OfferGiveListsError(409, "SEVERAL_OFFERS"));
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(409);
    mockFetchGiveLists.mockRejectedValueOnce(new OfferGiveListsError(500, "boom"));
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(502);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns the winner's email when a concurrent identical call won the insert", async () => {
    mockReturning.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505", constraint_name: "idx_email_previews_recipient" }));
    mockPreviewFindFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce(storedRow());
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
  });

  it("asks the same completion for highlights over the inputs actually sent, and stores + returns only the verified ones", async () => {
    mockReturning.mockImplementation(async () => [storedRow({ runId: "run-1", highlights: mockValues.mock.calls[0][0].highlights })]);
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(200);
    expect(mockGenerate).toHaveBeenCalledTimes(1);

    const [params] = mockGenerate.mock.calls[0];
    const ids = params.annotate.sources.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["recipient.title", "recipient.companyDomain", "audience", "brand.name", "brand.companyOverview", "instruction"]));
    expect(ids).not.toContain("recipient.headline");

    const stored = mockValues.mock.calls[0][0].highlights;
    expect(stored).toEqual([
      {
        text: "Hello.",
        start: 10,
        end: 16,
        kind: "prospect",
        source: "recipient.title",
        sourceLabel: "The prospect's job title",
        sourceValue: "VP Sales",
        reason: "She runs sales.",
      },
    ]);
    expect(res.body.highlights).toEqual(stored);
  });

  it("returns highlights: null for a preview stored before highlights existed", async () => {
    mockPreviewFindFirst.mockResolvedValue(storedRow({ highlights: null }));
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.body.highlights).toBeNull();
  });

  it("400s a recipient missing its name, title or company", async () => {
    const res = await request(app)
      .post("/preview-email")
      .send({ brandId: BRAND_ID, recipient: { firstName: "Jane", lastName: "Doe", companyName: "Acme" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("recipient.title");
    expect(mockFetchBrandIntel).not.toHaveBeenCalled();
  });
});
