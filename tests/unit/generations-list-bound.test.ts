import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * GET /generations was unbounded: it read every row matching the filter, each one
 * carrying the full prompt and raw model response. A single brand holds >10,000 of
 * them (~542 MB of row text in production), which exhausted the V8 heap and killed
 * the process — the caller saw a dropped connection, not an error.
 */

const mockFindMany = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return { from: mockFrom };
    },
    query: {
      emailGenerations: { findMany: mockFindMany, findFirst: vi.fn() },
      prompts: { findFirst: vi.fn() },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailGenerations: {
    id: { name: "id" },
    orgId: { name: "org_id" },
    campaignId: { name: "campaign_id" },
    brandIds: { name: "brand_ids" },
    runId: { name: "run_id" },
    createdAt: { name: "created_at" },
  },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn(),
  addCosts: vi.fn(),
}));
vi.mock("../../src/lib/campaign-client.js", () => ({ getCampaignFeatureInputs: vi.fn() }));
vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn(),
  resolveBrandNames: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("../../src/lib/chat-service-client.js", () => ({
  generateFromTemplate: vi.fn(),
  generateExpertQuotePitchFromTemplate: vi.fn(),
  substituteVariables: vi.fn(),
  findUnfilledPlaceholders: vi.fn(),
  InsufficientCreditsError: class extends Error {},
  ExpertQuotePitchLengthError: class extends Error {},
}));
vi.mock("../../src/lib/dynasty-client.js", () => ({
  resolveWorkflowDynastySlugs: vi.fn(),
  resolveFeatureDynastySlugs: vi.fn(),
  getWorkflowDynastyMap: vi.fn(),
  getFeatureDynastyMap: vi.fn(),
}));

const AUTH_HEADERS = {
  "X-Org-Id": "org-123",
  "X-User-Id": "user-456",
  "X-Run-Id": "run-789",
};

function row(i: number) {
  return { id: `gen-${i}`, subject: `s${i}` };
}

describe("GET /generations — bounded result set", () => {
  let app: express.Express;
  let MAX: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    const mod = await import("../../src/routes/generate.js");
    MAX = mod.MAX_GENERATIONS_PER_RESPONSE;
    app.use(mod.default);

    mockFrom.mockReturnValue({ where: mockWhere });
    mockFindMany.mockResolvedValue([]);
  });

  it("still requires at least one filter", async () => {
    const res = await request(app).get("/generations").set(AUTH_HEADERS);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one filter/i);
  });

  it("reads at most the ceiling plus one probe row when no limit is given", async () => {
    await request(app).get("/generations?brandId=brand-1").set(AUTH_HEADERS);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX + 1, offset: 0 })
    );
  });

  it("returns a small result set unchanged, each row carrying its resolved body", async () => {
    mockFindMany.mockResolvedValue([row(1), row(2)]);

    const res = await request(app).get("/generations?campaignId=camp-1").set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    // Rows keep every field they had; the body is resolved on top (these fixtures carry
    // no copy at all, which is reported as `none` rather than as an empty string).
    expect(res.body).toEqual({
      generations: [
        { ...row(1), bodyText: null, bodyHtml: null, bodySource: "none" },
        { ...row(2), bodyText: null, bodyHtml: null, bodySource: "none" },
      ],
    });
  });

  it("resolves a listed row's body out of its sequence", async () => {
    mockFindMany.mockResolvedValue([
      { ...row(1), bodyText: null, bodyHtml: null, sequence: [{ step: 1, bodyText: "Hey Nicky,", bodyHtml: "<p>Hey Nicky,</p>" }] },
    ]);

    const res = await request(app).get("/generations?campaignId=camp-1").set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.generations[0].bodyText).toBe("Hey Nicky,");
    expect(res.body.generations[0].bodySource).toBe("sequence");
  });

  it("refuses an oversized result set with 413 instead of returning a partial list", async () => {
    mockFindMany.mockResolvedValue(Array.from({ length: MAX + 1 }, (_, i) => row(i)));

    const res = await request(app).get("/generations?brandId=brand-1").set(AUTH_HEADERS);

    expect(res.status).toBe(413);
    expect(res.body.maxGenerations).toBe(MAX);
    expect(res.body.error).toMatch(/limit/);
    expect(res.body.error).toMatch(/offset/);
    // No silent truncation: the oversized case carries no generations at all.
    expect(res.body.generations).toBeUndefined();
  });

  it("returns exactly the requested page when limit is given, never 413", async () => {
    mockFindMany.mockResolvedValue(Array.from({ length: 50 }, (_, i) => row(i)));

    const res = await request(app)
      .get("/generations?brandId=brand-1&limit=50&offset=100")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.generations).toHaveLength(50);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, offset: 100 })
    );
  });

  it("honors a limit equal to the ceiling without refusing it", async () => {
    mockFindMany.mockResolvedValue(Array.from({ length: MAX }, (_, i) => row(i)));

    const res = await request(app)
      .get(`/generations?brandId=brand-1&limit=${MAX}`)
      .set(AUTH_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.generations).toHaveLength(MAX);
  });

  it.each([
    ["limit above the ceiling", `limit=${5000}`],
    ["limit of zero", "limit=0"],
    ["non-numeric limit", "limit=all"],
    ["negative limit", "limit=-1"],
  ])("rejects %s with 400", async (_label, qs) => {
    const res = await request(app).get(`/generations?brandId=brand-1&${qs}`).set(AUTH_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed offset with 400", async () => {
    const res = await request(app)
      .get("/generations?brandId=brand-1&offset=abc")
      .set(AUTH_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/offset/);
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});

describe("POST /stats — counted in SQL", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    const mod = await import("../../src/routes/generate.js");
    app.use(mod.default);

    mockFrom.mockReturnValue({ where: mockWhere });
  });

  it("counts without reading every matching row back", async () => {
    mockWhere.mockResolvedValue([{ emailsGenerated: 40925 }]);

    const res = await request(app)
      .post("/stats")
      .set(AUTH_HEADERS)
      .send({ brandId: "brand-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stats: { emailsGenerated: 40925 } });
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
