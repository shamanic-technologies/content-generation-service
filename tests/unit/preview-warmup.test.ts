import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// POST /preview-email/prepare warms the brand intel the first preview needs, so the visitor
// waits only for the model. These tests pin: the caller is answered at once (202) while the
// brand-service read runs in the background; the read is EXACTLY the preview's own request
// (same workflow field set, same identity headers → same org billed); repeats never start a
// second read; and a preview arriving mid-warm-up waits for it instead of reading the site
// a second time.

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "11111111-1111-1111-1111-111111111111";
    req.userId = req.headers["x-user-id"] || "user-1";
    req.runId = req.headers["x-run-id"] || "run-1";
    next();
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailPreviews: { orgId: {}, brandId: {}, recipientKey: {} },
  emailGenerations: {},
  prompts: { type: {} },
}));

const mockPreviewFindFirst = vi.fn();
const mockPromptFindFirst = vi.fn();
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
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
  class BrandRowsError extends Error {}
  return {
    BrandIntelError,
    BrandRowsError,
    fetchBrandIntel: (...a: unknown[]) => mockFetchBrandIntel(...a),
    fetchBrandRows: vi.fn(),
  };
});

const mockResolvePreviewWorkflow = vi.fn();
vi.mock("../../src/lib/preview-workflow-client.js", () => ({
  resolvePreviewWorkflow: (...a: unknown[]) => mockResolvePreviewWorkflow(...a),
}));

vi.mock("../../src/lib/offer-give-lists-client.js", () => ({
  OfferGiveListsError: class extends Error {},
  fetchOfferGiveLists: vi.fn().mockResolvedValue(null),
}));

const mockGenerate = vi.fn();
vi.mock("../../src/lib/chat-service-client.js", () => ({
  InsufficientCreditsError: class extends Error {},
  generateFromTemplate: (...a: unknown[]) => mockGenerate(...a),
}));

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

import previewRoutes from "../../src/routes/preview-email.js";
import { __resetPreviewWarmups, awaitPreviewWarmup } from "../../src/lib/preview-warmup.js";
import { BRAND_INTEL_FIELDS } from "../../src/lib/preview-email.js";

const app = express();
app.use(express.json());
app.use(previewRoutes);

const ORG = "22222222-2222-2222-2222-222222222222";
const BRAND_ID = "5f0c7a2e-8b1d-4c3e-9a4f-6d2b1e0c9a77";
const PLAN_FIELDS = [{ key: "companyOverview", description: "A comprehensive overview of the company" }];
const PLAN = {
  workflowSlug: "sales-cold-email-outreach-nobelium-v5",
  workflowDynastySlug: "sales-cold-email-outreach-nobelium",
  promptType: "blind-discovery-email-v33",
  model: "glm-pro",
  brandIntelFields: PLAN_FIELDS,
  sources: {},
};
const INTEL = {
  brands: [{ brandId: BRAND_ID, domain: "brand.io", name: "Brand Co" }],
  fields: { companyOverview: { value: "We do X", byBrand: { "brand.io": { value: "We do X", cached: false } } } },
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const prepare = (body: Record<string, unknown> = { brandId: BRAND_ID }) =>
  request(app).post("/preview-email/prepare").set("x-org-id", ORG).set("x-user-id", "user-9").set("x-run-id", "run-warm").send(body);

beforeEach(() => {
  vi.clearAllMocks();
  __resetPreviewWarmups();
  mockResolvePreviewWorkflow.mockResolvedValue(PLAN);
});

describe("POST /preview-email/prepare", () => {
  it("answers 202 started before the brand-service read finishes", async () => {
    const read = deferred<typeof INTEL>();
    mockFetchBrandIntel.mockReturnValue(read.promise);

    const res = await prepare();

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ brandId: BRAND_ID, status: "started" });
    // Still running in the background after the caller got its answer.
    read.resolve(INTEL);
    await awaitPreviewWarmup(ORG, BRAND_ID);
    expect(mockFetchBrandIntel).toHaveBeenCalledTimes(1);
  });

  it("sends the preview's own request: the workflow's field set, under the caller's identity (same org billed)", async () => {
    mockFetchBrandIntel.mockResolvedValue(INTEL);
    const offerId = "9d7f2c1a-3b4e-4f5a-8c6d-7e8f9a0b1c2d";

    await prepare({ brandId: BRAND_ID, offerId });
    await awaitPreviewWarmup(ORG, BRAND_ID);

    expect(mockFetchBrandIntel).toHaveBeenCalledWith(PLAN_FIELDS, { orgId: ORG, userId: "user-9", runId: "run-warm", brandId: BRAND_ID, offerId });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("falls back to the same default field set as the preview when the workflow feeds none", async () => {
    mockResolvePreviewWorkflow.mockResolvedValue({ ...PLAN, brandIntelFields: null });
    mockFetchBrandIntel.mockResolvedValue(INTEL);

    await prepare();
    await awaitPreviewWarmup(ORG, BRAND_ID);

    expect(mockFetchBrandIntel.mock.calls[0][0]).toBe(BRAND_INTEL_FIELDS);
  });

  it("never starts a second read: in_progress while running, ready once done", async () => {
    const read = deferred<typeof INTEL>();
    mockFetchBrandIntel.mockReturnValue(read.promise);

    expect((await prepare()).body.status).toBe("started");
    expect((await prepare()).body.status).toBe("in_progress");
    read.resolve(INTEL);
    await awaitPreviewWarmup(ORG, BRAND_ID);
    expect((await prepare()).body.status).toBe("ready");

    expect(mockFetchBrandIntel).toHaveBeenCalledTimes(1);
  });

  it("a failed warm-up is not remembered as ready, so a later call retries", async () => {
    mockFetchBrandIntel.mockRejectedValueOnce(new Error("brand-service down")).mockResolvedValueOnce(INTEL);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await prepare();
    await awaitPreviewWarmup(ORG, BRAND_ID);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("preview warm-up FAILED"))).toBe(true);

    expect((await prepare()).body.status).toBe("started");
    await awaitPreviewWarmup(ORG, BRAND_ID);
    expect(mockFetchBrandIntel).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });

  it("400s a body without a valid brandId and starts nothing", async () => {
    const res = await prepare({ brandId: "nope" });
    expect(res.status).toBe(400);
    expect(mockResolvePreviewWorkflow).not.toHaveBeenCalled();
  });
});

describe("POST /preview-email while a warm-up runs", () => {
  it("waits for the warm-up before its own brand-service read", async () => {
    const warm = deferred<typeof INTEL>();
    const order: string[] = [];
    mockFetchBrandIntel
      .mockImplementationOnce(() => warm.promise.then((v) => (order.push("warm-done"), v)))
      .mockImplementationOnce(async () => (order.push("preview-read"), INTEL));
    mockPreviewFindFirst.mockResolvedValue(undefined);
    // Stop the preview right after its brand read: the order is all this test is about.
    mockPromptFindFirst.mockResolvedValue(undefined);

    await prepare();
    const preview = request(app)
      .post("/preview-email")
      .set("x-org-id", ORG)
      .send({ brandId: BRAND_ID, recipient: { firstName: "Jane", lastName: "Doe", title: "VP Sales", companyName: "Acme" } })
      .then((r) => r);

    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    warm.resolve(INTEL);
    await preview;

    expect(order).toEqual(["warm-done", "preview-read"]);
  });
});
