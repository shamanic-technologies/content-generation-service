import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// POST /preview-email writes ONE cold email for a brand + a sample recipient, before any
// campaign exists. These tests pin: the live template + brand-intel request are reused,
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
vi.mock("../../src/lib/brand-client.js", () => {
  class BrandIntelError extends Error {
    constructor(public status: number, public body: string) {
      super(`brand-service extract-fields failed: ${status} - ${body}`);
    }
  }
  return {
    BrandIntelError,
    fetchBrandIntel: (...a: unknown[]) => mockFetchBrandIntel(...a),
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
import { BRAND_INTEL_FIELDS, PREVIEW_PROMPT_TYPE } from "../../src/lib/preview-email.js";

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

const TEMPLATE = "Prospect {{leadFirstName}} {{leadLastName}}, {{leadTitle}} at {{leadCompanyName}} ({{leadCompanyIndustry}}). Client {{clientName}}. Intel {{brandExtractedFields}}";

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    orgId: "11111111-1111-1111-1111-111111111111",
    brandId: BRAND_ID,
    brandName: "Brand Co",
    runId: "run-0",
    recipientKey: "k",
    recipient: BODY.recipient,
    promptType: PREVIEW_PROMPT_TYPE,
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
  mockPromptFindFirst.mockResolvedValue({ type: PREVIEW_PROMPT_TYPE, prompt: TEMPLATE });
  mockFetchBrandIntel.mockResolvedValue(INTEL);
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
  it("writes the first email with the live template, the live brand-intel request, and the caller's org identity", async () => {
    const res = await request(app).post("/preview-email").send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      brandId: BRAND_ID,
      brandName: "Brand Co",
      subject: "Quick question",
      bodyText: "Hi Jane,\n\nHello.",
      cached: false,
    });

    // Same field set (keys + descriptions) the live workflows send, under the caller's org.
    const [fields, identity] = mockFetchBrandIntel.mock.calls[0];
    expect(fields).toEqual(BRAND_INTEL_FIELDS);
    expect(identity).toMatchObject({ orgId: "11111111-1111-1111-1111-111111111111", userId: "user-1", runId: "run-1", brandId: BRAND_ID });

    const [params, chatIdentity] = mockGenerate.mock.calls[0];
    expect(params.promptTemplate).toBe(TEMPLATE);
    expect(params.model).toBe("sonnet");
    expect(params.disableThinking).toBe(true);
    expect(params.variables).toMatchObject({
      leadFirstName: "Jane",
      leadTitle: "VP Sales",
      leadCompanyName: "Acme",
      leadCompanyWebsiteUrl: "acme.com",
      clientName: "Brand Co",
      brandExtractedFields: INTEL,
      leadCompanyIndustry: "",
    });
    expect(params.campaignContext).toEqual({ audience: BODY.audience });
    expect(chatIdentity).toMatchObject({ orgId: "11111111-1111-1111-1111-111111111111", runId: "run-1", brandId: BRAND_ID });
  });

  it("stores the preview in email_previews only — never in email_generations", async () => {
    await request(app).post("/preview-email").send(BODY);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0]).toBe(EMAIL_PREVIEWS);
    expect(mockValues.mock.calls[0][0]).toMatchObject({ bodyText: "Hi Jane,\n\nHello.", brandName: "Brand Co" });
  });

  it("answers a repeat from storage without calling brand-service or chat-service", async () => {
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
