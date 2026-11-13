import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// POST /preview-email writes ONE cold email for a brand + a sample recipient, before any campaign exists
// (PREVIEW-EMAIL-503-1111). These tests pin: the email Engine's script the strategy keeps writes it (run through
// workflow-service under the caller's identity, recorded by us, declaring nothing), with the template + LLM
// features-service picks and the materials every script writer gets; a brand with zero history and no campaign gets
// an email with or without a strategy; no fallback script/template/model; a refusal to pay is a clean 402; a repeat is
// answered from storage with no downstream call; nothing is written to email_generations.

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

const mockDynastyIdentityOf = vi.fn();
vi.mock("../../src/lib/dynasty-membership.js", () => ({
  dynastyIdentityOf: (...a: unknown[]) => mockDynastyIdentityOf(...a),
}));

const mockFetchBrandIntel = vi.fn();
const mockExtractBrandFields = vi.fn();
vi.mock("../../src/lib/brand-client.js", () => {
  class BrandIntelError extends Error {
    constructor(public status: number, public body: string) {
      super(`brand-service extract-fields failed: ${status} - ${body}`);
    }
  }
  return {
    BrandIntelError,
    fetchBrandIntel: (...a: unknown[]) => mockFetchBrandIntel(...a),
    extractBrandFields: (...a: unknown[]) => mockExtractBrandFields(...a),
  };
});

const mockResolvePreviewWriter = vi.fn();
vi.mock("../../src/lib/preview-writer-client.js", () => ({
  resolvePreviewWriter: (...a: unknown[]) => mockResolvePreviewWriter(...a),
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

const mockRunScript = vi.fn();
vi.mock("../../src/lib/script-run-client.js", () => {
  class ScriptRunError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return { ScriptRunError, runScript: (...a: unknown[]) => mockRunScript(...a) };
});

const mockAnnotate = vi.fn();
vi.mock("../../src/lib/preview-annotate-client.js", () => ({
  annotatePreviewEmail: (...a: unknown[]) => mockAnnotate(...a),
}));

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

import previewRoutes from "../../src/routes/preview-email.js";
import { BrandIntelError } from "../../src/lib/brand-client.js";
import { OfferGiveListsError } from "../../src/lib/offer-give-lists-client.js";
import { ScriptRunError } from "../../src/lib/script-run-client.js";
import { PreviewWriterError, type PreviewWriterPlan } from "../../src/lib/preview-writer.js";
import { BRAND_INTEL_FIELDS } from "../../src/lib/preview-email.js";

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

const TEMPLATE = "Today {{currentDate}}. Prospect {{leadFirstName}} {{leadLastName}}, {{leadTitle}} at {{leadCompanyName}} ({{leadCompanyIndustry}}, {{leadCompanySize}}). Client {{clientName}}. Intel {{brandExtractedFields}}. Site {{brandWebsiteUrl}}";

// The writer features-service + workflow-service name today. Deliberately not a real head: the route uses whatever the plan says.
const PLAN: PreviewWriterPlan = {
  script: { dynasty: "dy_template_writer_full", version: 4 },
  emailScript: { engine: "email_sent", dynasty: "dy_cold_email", version: 10 },
  templateDynastySlug: "cold-reply-three-line-reply-named",
  promptType: "blind-discovery-email-v33",
  model: "glm-pro",
};

/** What workflow-service answers for a made script run with `trace: true`. */
function scriptAnswer(over: Record<string, unknown> = {}) {
  return {
    scriptId: "1fd82c22-b7bc-42ee-a8ed-26081d0d921c",
    scriptSlug: "message_written/dy_template_writer_full/v4",
    version: 4,
    runId: "script-run-1",
    status: "made",
    unit: {
      outcome: "message_written",
      subject: { service: "content-generation-service", id: "preview:k" },
      content: {
        subject: "Quick question",
        sequence: [
          { step: 1, bodyText: "Hi Jane,\n\nHello.", bodyHtml: "<p>Hi Jane,</p><p>Hello.</p>", daysSinceLastStep: 0 },
          { step: 2, bodyText: "Following up.", bodyHtml: "<p>Following up.</p>", daysSinceLastStep: 3 },
        ],
      },
    },
    error: null,
    vendorCalls: [],
    declared: { produced: [], consumed: [] },
    trace: [
      { name: "voice.read", args: {}, answer: { data: { content: "Our voice." } } },
      { name: "llm.complete", args: {}, answer: {}, sent: { message: "the message", systemPrompt: "the system", responseSchema: {}, provider: "zai", model: "glm-pro" }, raw: { model: "glm-5.1", tokensInput: 100, tokensOutput: 50 } },
    ],
    ...over,
  };
}

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
    model: "glm-5.1",
    createdAt: new Date("2026-09-28T10:00:00Z"),
    ...overrides,
  };
}

/** The variables the script was handed (the lead and brand halves of its materials, merged). */
function sentVariables(call = 0): Record<string, unknown> {
  const units = mockRunScript.mock.calls[call][0].units;
  return { ...units.lead_identified.content.variables, ...units.brand_context.content.variables };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPreviewFindFirst.mockResolvedValue(undefined);
  mockPromptFindFirst.mockResolvedValue({ type: PLAN.promptType, prompt: TEMPLATE });
  mockResolvePreviewWriter.mockResolvedValue(PLAN);
  mockDynastyIdentityOf.mockResolvedValue("named");
  mockExtractBrandFields.mockResolvedValue(new Map());
  mockFetchBrandIntel.mockResolvedValue(INTEL);
  mockFetchGiveLists.mockResolvedValue({ giveForFree: [], neverGive: [] });
  mockRunScript.mockResolvedValue(scriptAnswer());
  mockAnnotate.mockResolvedValue({
    highlights: [
      { text: "Hello.", source: "recipient.title", reason: "She runs sales." },
      { text: "Invented.", source: "recipient.title", reason: "not in the body" },
    ],
    tokensInput: 10,
    tokensOutput: 5,
    model: "claude-sonnet-5-5",
  });
  mockReturning.mockImplementation(async () => [storedRow({ runId: "run-1" })]);
});

describe("POST /preview-email", () => {
  it("a brand with zero history and no campaign gets an email written by the email Engine's script", async () => {
    const res = await request(app).post("/preview-email").send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ brandId: BRAND_ID, brandName: "Brand Co", subject: "Quick question", bodyText: "Hi Jane,\n\nHello.", cached: false });

    // The writer is read with no strategy (every runnable script, the Rating's template + LLM), the picks recorded on
    // the preview's own run.
    expect(mockResolvePreviewWriter).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }), undefined);

    // The script run: the kept script, under the caller's identity, recorded by us (it declares nothing), traced.
    const [body, identity] = mockRunScript.mock.calls[0];
    expect(body).toMatchObject({
      outcome: "message_written",
      dynasty: "dy_template_writer_full",
      version: 4,
      recordedBy: "content-generation",
      trace: true,
      tactics: { llm: { provider: "zai", model: "glm-pro" } },
    });
    expect(body.subject.service).toBe("content-generation-service");
    expect(identity).toMatchObject({ orgId: "11111111-1111-1111-1111-111111111111", userId: "user-1", runId: "run-1", brandId: BRAND_ID });

    // The materials every script writer gets: the picked head's text, the lead half, the brand half.
    expect(body.units.template_written.content.text).toBe(TEMPLATE);
    expect(body.units.lead_identified.content.variables).toMatchObject({ leadFirstName: "Jane", leadTitle: "VP Sales", leadCompanyName: "Acme", leadCompanyWebsiteUrl: "acme.com", leadCompanySize: "" });
    expect(body.units.brand_context.content).toMatchObject({ variables: { clientName: "Brand Co", brandExtractedFields: INTEL.fields }, campaignContext: { audience: BODY.audience } });
    expect("language" in body.units.lead_identified.content).toBe(false);
    expect("instruction" in body.units.brand_context.content).toBe(false);
  });

  it("with a strategyId: the script, template and LLM that strategy keeps", async () => {
    await request(app).post("/preview-email").send({ ...BODY, strategyId: "named-emails-only" });
    expect(mockResolvePreviewWriter).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }), "named-emails-only");
    expect(mockRunScript).toHaveBeenCalledTimes(1);
  });

  it("a strategy that keeps no script answers its named refusal: nothing written, nothing billed", async () => {
    mockResolvePreviewWriter.mockRejectedValue(new PreviewWriterError(422, "Under strategy blind-emails-only, the email Engine keeps no script", "NO_SCRIPT_KEPT"));
    const res = await request(app).post("/preview-email").send({ ...BODY, strategyId: "blind-emails-only" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "NO_SCRIPT_KEPT" });
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("answers an unknown strategy with a named 400, nothing billed", async () => {
    mockResolvePreviewWriter.mockRejectedValue(new PreviewWriterError(400, 'strategyId: features-service knows no strategy "nope"', "UNKNOWN_STRATEGY"));
    const res = await request(app).post("/preview-email").send({ ...BODY, strategyId: "nope" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "UNKNOWN_STRATEGY" });
    expect(mockRunScript).not.toHaveBeenCalled();
    expect((await request(app).post("/preview-email").send({ ...BODY, strategyId: "" })).status).toBe(400);
  });

  it("fails loud when no writer can be read: no fallback script, template or model", async () => {
    mockResolvePreviewWriter.mockRejectedValue(new PreviewWriterError(503, "the cold email script states a template dynasty with no head", "WRITER_PICK_UNAVAILABLE"));
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("WRITER_PICK_UNAVAILABLE");
    expect(mockPromptFindFirst).not.toHaveBeenCalled();
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("fills a template input nothing else fills from brand-service, as /generate does; a lead fact never", async () => {
    mockExtractBrandFields.mockResolvedValue(new Map([["brandWebsiteUrl", "https://brand.io/start"]]));
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(200);
    expect(mockExtractBrandFields.mock.calls[0][0]).toEqual([{ key: "brandWebsiteUrl", description: 'Value for the "brandWebsiteUrl" field needed in content generation' }]);
    const v = sentVariables();
    expect(v.brandWebsiteUrl).toBe("https://brand.io/start");
    // Lead facts the recipient lacks are empty, never invented, never asked of brand-service.
    expect(v.leadCompanyIndustry).toBe("");
    expect(v.leadCompanySize).toBe("");
    expect(v.currentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("an input brand-service cannot answer is empty, so no {{token}} leaks", async () => {
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(200);
    expect(sentVariables().brandWebsiteUrl).toBe("");
  });

  it("asks brand-service the facts the Engine's cold-email script asks, under the caller's org", async () => {
    await request(app).post("/preview-email").send(BODY);
    const [fields, identity] = mockFetchBrandIntel.mock.calls[0];
    expect(fields).toBe(BRAND_INTEL_FIELDS);
    expect(identity).toMatchObject({ orgId: "11111111-1111-1111-1111-111111111111", userId: "user-1", runId: "run-1", brandId: BRAND_ID });
  });

  it("a blind template's writer never sees who the client is", async () => {
    mockDynastyIdentityOf.mockResolvedValue("blind");
    await request(app).post("/preview-email").send(BODY);
    expect(JSON.stringify(mockRunScript.mock.calls[0][0].units.brand_context)).not.toContain("Brand Co");
  });

  it("records the script, template and model that wrote the stored preview", async () => {
    mockReturning.mockImplementation(async () => [storedRow({ runId: "run-1", ...mockValues.mock.calls[0][0] })]);
    const res = await request(app).post("/preview-email").send(BODY);
    expect(mockValues.mock.calls[0][0]).toMatchObject({
      promptType: "blind-discovery-email-v33",
      modelAlias: "glm-pro",
      scriptSlug: "message_written/dy_template_writer_full/v4",
      templateDynastySlug: "cold-reply-three-line-reply-named",
      model: "glm-5.1",
      tokensInput: 100,
      tokensOutput: 50,
      promptRaw: "the message",
      subject: "Quick question",
    });
    // One email per generation (FOLLOWUP-JIT-1107): the follow-up the script wrote is not kept.
    expect(mockValues.mock.calls[0][0].sequence).toHaveLength(1);
    expect(res.body).toMatchObject({ scriptSlug: "message_written/dy_template_writer_full/v4", templateDynastySlug: "cold-reply-three-line-reply-named", workflowSlug: null });
  });

  it("writes a new preview when the script version, template or LLM changes", async () => {
    await request(app).post("/preview-email").send(BODY);
    const first = mockValues.mock.calls[0][0].recipientKey;
    mockResolvePreviewWriter.mockResolvedValue({ ...PLAN, script: { ...PLAN.script, version: 5 } });
    await request(app).post("/preview-email").send(BODY);
    mockResolvePreviewWriter.mockResolvedValue({ ...PLAN, model: "deepseek-flash" });
    await request(app).post("/preview-email").send(BODY);
    const keys = mockValues.mock.calls.map((c) => c[0].recipientKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("refuses a caller-chosen model", async () => {
    const res = await request(app).post("/preview-email").send({ ...BODY, model: "sonnet" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("model");
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("a script that made nothing is a named 502, nothing stored", async () => {
    mockRunScript.mockResolvedValue(scriptAnswer({ status: "nothing", unit: null }));
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("SCRIPT_WROTE_NOTHING");
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("refuses an org that cannot afford the completion with a clean 402", async () => {
    mockRunScript.mockRejectedValue(new ScriptRunError(402, "workflow-service script message_written/dy_template_writer_full failed: 502 - llm.complete 402"));
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("Insufficient credits");
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("a failed script run is a named 502", async () => {
    mockRunScript.mockRejectedValue(new ScriptRunError(502, "workflow-service script failed: 502 - boom"));
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("SCRIPT_RUN_FAILED");
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
    expect(mockRunScript).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("passes brand-service's verdict on the brand through (404 not found, 409 several offers)", async () => {
    mockFetchBrandIntel.mockRejectedValueOnce(new BrandIntelError(404, "Brand not found"));
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(404);
    mockFetchBrandIntel.mockRejectedValueOnce(new BrandIntelError(409, "SEVERAL_OFFERS"));
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(409);
    mockFetchBrandIntel.mockRejectedValueOnce(new BrandIntelError(500, "boom"));
    expect((await request(app).post("/preview-email").send(BODY)).status).toBe(502);
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("writes with the offer's give lists: passed to the completion, and the free-give list is a highlight source", async () => {
    const lists = { giveForFree: ["A free pipeline audit"], neverGive: ["Discounts"] };
    mockFetchGiveLists.mockResolvedValue(lists);
    const res = await request(app).post("/preview-email").send({ ...BODY, offerId: "9a1b2c3d-0000-4000-8000-000000000001" });
    expect(res.status).toBe(200);

    const [identity] = mockFetchGiveLists.mock.calls[0];
    expect(identity).toMatchObject({ brandId: BRAND_ID, offerId: "9a1b2c3d-0000-4000-8000-000000000001" });

    expect(mockRunScript.mock.calls[0][0].units.brand_context.content.giveLists).toEqual(lists);
    const [annotateInput] = mockAnnotate.mock.calls[0];
    const source = annotateInput.sources.find((s: { id: string }) => s.id === "offer.giveForFree");
    expect(source).toBeDefined();
    // The won't-give list is never something an email rests on.
    expect(annotateInput.sources.map((s: { id: string }) => s.id).join(" ")).not.toContain("neverGive");
  });

  it("offers no free-give highlight source when the lists are empty", async () => {
    await request(app).post("/preview-email").send(BODY);
    expect(mockRunScript.mock.calls[0][0].units.brand_context.content.giveLists).toEqual({ giveForFree: [], neverGive: [] });
    expect(mockAnnotate.mock.calls[0][0].sources.map((s: { id: string }) => s.id)).not.toContain("offer.giveForFree");
  });

  const QUALIFICATION = {
    domain: "acme.com",
    checks: [
      { criterionId: "c1", question: "Do they sell to enterprises?", mode: "must_pass", verdict: "yes", evidence: "Their pricing page lists an Enterprise plan.", checkedAt: "2026-10-17T10:00:00Z", yesProbability: 0.93 },
      { criterionId: "c2", question: "Are they hiring SDRs?", mode: "mention", verdict: "no", evidence: "No open sales roles on their careers page.", checkedAt: "2026-10-17T10:00:00Z", yesProbability: 0.1 },
    ],
  };

  it("hands the writer the company's check results as leadQualification, verbatim, like a campaign /generate", async () => {
    await request(app).post("/preview-email").send({ ...BODY, qualification: QUALIFICATION });
    expect(sentVariables().leadQualification).toEqual(QUALIFICATION);
    const ids = mockAnnotate.mock.calls[0][0].sources.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["check.1", "check.2"]));
  });

  it("writes exactly as without checks when there are none (absent or checks: [])", async () => {
    await request(app).post("/preview-email").send(BODY);
    await request(app).post("/preview-email").send({ ...BODY, qualification: { domain: "acme.com", checks: [] } });
    for (const n of [0, 1]) {
      expect("leadQualification" in sentVariables(n)).toBe(false);
    }
    expect(mockValues.mock.calls[1][0].recipientKey).toBe(mockValues.mock.calls[0][0].recipientKey);
    expect(mockAnnotate.mock.calls[0][0].sources).toEqual(mockAnnotate.mock.calls[1][0].sources);
  });

  it("stores a new preview when the check results change, and the same one when only checkedAt moves", async () => {
    await request(app).post("/preview-email").send(BODY);
    await request(app).post("/preview-email").send({ ...BODY, qualification: QUALIFICATION });
    const rerun = { ...QUALIFICATION, checks: QUALIFICATION.checks.map((c) => ({ ...c, checkedAt: "2026-10-18T09:00:00Z", yesProbability: 0.5 })) };
    await request(app).post("/preview-email").send({ ...BODY, qualification: rerun });
    const flipped = { ...QUALIFICATION, checks: [QUALIFICATION.checks[0], { ...QUALIFICATION.checks[1], verdict: "yes", evidence: "Two SDR roles open." }] };
    await request(app).post("/preview-email").send({ ...BODY, qualification: flipped });
    const keys = mockValues.mock.calls.map((c) => c[0].recipientKey);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
    expect(keys[3]).not.toBe(keys[1]);
  });

  it("rejects a qualification whose checks are not a list", async () => {
    const res = await request(app).post("/preview-email").send({ ...BODY, qualification: { domain: "acme.com", checks: "yes" } });
    expect(res.status).toBe(400);
    expect(mockRunScript).not.toHaveBeenCalled();
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
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("returns the winner's email when drizzle wraps the duplicate key in a DrizzleQueryError", async () => {
    const { DrizzleQueryError } = await import("drizzle-orm");
    mockReturning.mockRejectedValue(new DrizzleQueryError("insert ...", [], Object.assign(new Error("dup"), { code: "23505", constraint_name: "idx_email_previews_recipient" })));
    mockPreviewFindFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce(storedRow());
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
  });

  it("returns the winner's email when a concurrent identical call won the insert", async () => {
    mockReturning.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505", constraint_name: "idx_email_previews_recipient" }));
    mockPreviewFindFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce(storedRow());
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
  });

  it("the script writes, then a second call reads the finished email for highlights, storing only the verified ones", async () => {
    mockReturning.mockImplementation(async () => [storedRow({ runId: "run-1", highlights: mockValues.mock.calls[0][0].highlights })]);
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(200);
    expect(mockRunScript).toHaveBeenCalledTimes(1);
    expect(mockAnnotate).toHaveBeenCalledTimes(1);

    const [annotateInput, annotateIdentity] = mockAnnotate.mock.calls[0];
    expect(annotateInput.bodyText).toBe("Hi Jane,\n\nHello.");
    expect(annotateIdentity.orgId).toBe("11111111-1111-1111-1111-111111111111");
    expect(annotateIdentity.runId).toBe("run-1");
    const ids = annotateInput.sources.map((s: { id: string }) => s.id);
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

  it("serves the email without highlights when the annotate call fails, never blocking it", async () => {
    mockAnnotate.mockRejectedValueOnce(new Error("chat-service /complete failed (preview annotate): 402"));
    mockReturning.mockImplementation(async () => [storedRow({ runId: "run-1", highlights: mockValues.mock.calls[0][0].highlights })]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).post("/preview-email").send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.bodyText).toBe("Hi Jane,\n\nHello.");
    expect(mockValues.mock.calls[0][0].highlights).toBeNull();
    expect(res.body.highlights).toBeNull();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("annotate FAILED"))).toBe(true);
    errSpy.mockRestore();
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
