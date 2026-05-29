import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  EXPERT_QUOTE_PITCH_TEMPLATE,
  EXPERT_QUOTE_PITCH_TYPE,
  EXPERT_QUOTE_PITCH_VARIABLES,
} from "../../src/lib/expert-quote-pitch-template";

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-1";
    req.userId = req.headers["x-user-id"] || "user-1";
    req.runId = req.headers["x-run-id"] || "run-1";
    next();
  },
}));

const mockPromptFindFirst = vi.fn();
const mockAssignmentFindFirst = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "gen-1" }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
    query: {
      prompts: { findFirst: (...args: unknown[]) => mockPromptFindFirst(...args) },
      emailGenerations: { findFirst: vi.fn(), findMany: vi.fn() },
      featurePromptAssignment: { findFirst: (...args: unknown[]) => mockAssignmentFindFirst(...args) },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  prompts: { type: { name: "type" }, orgId: { name: "org_id" } },
  emailGenerations: { id: { name: "id" } },
  featurePromptAssignment: { featureSlug: { name: "feature_slug" }, promptType: { name: "prompt_type" } },
}));

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-tracker-1" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

vi.mock("../../src/lib/campaign-client.js", () => ({
  getCampaignFeatureInputs: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../src/lib/dynasty-client.js", () => ({
  resolveWorkflowDynastySlugs: vi.fn(),
  resolveFeatureDynastySlugs: vi.fn(),
  getWorkflowDynastyMap: vi.fn(),
  getFeatureDynastyMap: vi.fn(),
}));

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

const mockGenerateExpertQuotePitch = vi.fn();
vi.mock("../../src/lib/chat-service-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/chat-service-client.js")>(
    "../../src/lib/chat-service-client.js"
  );
  return {
    ...actual,
    generateFromTemplate: vi.fn(),
    generateExpertQuotePitchFromTemplate: (...args: unknown[]) => mockGenerateExpertQuotePitch(...args),
  };
});

function makeApp() {
  const app = express();
  app.use(express.json());
  return app;
}

const FIXTURE_A = {
  variables: {
    brand: {
      name: "Acme SaaS",
      industry: "B2B SaaS",
      expertise: "scaling early-stage engineering teams",
      voice: "blunt, no jargon, anecdote-driven",
      targetAudience: "early-stage founders and CTOs",
    },
    request: {
      question: "What's the most common mistake startups make when their team grows from 5 to 25 engineers?",
      mediaOutlet: "TechCrunch",
      source: "Jane Doe",
      deadline: "Friday at 5pm ET",
    },
  },
};

const FIXTURE_B = {
  variables: {
    brand: {
      name: "Northwind Agency",
      industry: "Marketing services",
      expertise: "content strategy for fintech",
      voice: "warm, specific, slightly contrarian",
      targetAudience: "fintech CMOs",
    },
    request: {
      question: "How should fintechs balance growth content vs. compliance content?",
      mediaOutlet: "Modern Marketer",
      source: "Sam Reporter",
    },
    additionalContext: "Recently published a study on conversion lift from regulatory deep-dives.",
  },
};

const FIXTURE_C = {
  variables: {
    brand: {
      name: "Glow & Grow",
      industry: "DTC ecommerce — skincare",
      expertise: "supply chain for sub-$50 SKUs",
      voice: "practical, founder-first, no fluff",
      targetAudience: "DTC operators",
    },
    request: {
      question: "What's the right way to think about MOQ when launching a new SKU under $50?",
      mediaOutlet: "Retail Dive",
      source: "Pat Editor",
      deadline: "next Tuesday",
    },
  },
};

const FIXTURE_MULTIBRAND = {
  variables: {
    brand: [
      {
        name: "Acme SaaS",
        industry: "B2B SaaS",
        expertise: "scaling early-stage engineering teams",
        voice: "blunt, no jargon, anecdote-driven",
        targetAudience: "early-stage founders and CTOs",
      },
      {
        name: "Northwind Agency",
        industry: "Marketing services",
        expertise: "content strategy for fintech",
        voice: "warm, specific, slightly contrarian",
        targetAudience: "fintech CMOs",
      },
    ],
    request: {
      question: "Where do early-stage SaaS and B2B agencies converge on content strategy?",
      mediaOutlet: "Modern Marketer",
    },
  },
};

describe("POST /generate-expert-quote-pitch", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAssignmentFindFirst.mockResolvedValue(null); // no feature assignment by default
    mockPromptFindFirst.mockResolvedValue({
      id: "p-1",
      orgId: null,
      type: EXPERT_QUOTE_PITCH_TYPE,
      prompt: EXPERT_QUOTE_PITCH_TEMPLATE,
      variables: EXPERT_QUOTE_PITCH_VARIABLES,
    });
    mockGenerateExpertQuotePitch.mockResolvedValue({
      pitch: "x".repeat(500),
      charCount: 500,
      attempts: 1,
      tokensInput: 200,
      tokensOutput: 80,
      model: "claude-sonnet-4-6",
      promptRaw: "rendered",
      responseRaw: {},
    });
    app = makeApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("fixture A — SaaS founder — returns pitch in [100,2500]", async () => {
    const res = await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send(FIXTURE_A)
      .expect(200);

    expect(res.body.pitch.length).toBeGreaterThanOrEqual(100);
    expect(res.body.pitch.length).toBeLessThanOrEqual(2500);
    expect(res.body.charCount).toBe(500);
    expect(res.body.attempts).toBe(1);
    expect(res.body.tokensInput).toBe(200);
  });

  it("fixture B — passes caller's variables object through to the template renderer unchanged", async () => {
    const res = await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send(FIXTURE_B)
      .expect(200);

    expect(res.body.pitch).toBeDefined();

    expect(mockGenerateExpertQuotePitch).toHaveBeenCalledTimes(1);
    const [params] = mockGenerateExpertQuotePitch.mock.calls[0];
    expect(params.minChars).toBe(100);
    expect(params.maxChars).toBe(2500);
    // Caller's variables JSON is forwarded as-is — no shape mapping in the route.
    expect(params.variables).toEqual(FIXTURE_B.variables);
  });

  it("fixture multibrand — passes an array of brand profiles untouched", async () => {
    await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send(FIXTURE_MULTIBRAND)
      .expect(200);

    const [params] = mockGenerateExpertQuotePitch.mock.calls[0];
    expect(Array.isArray(params.variables.brand)).toBe(true);
    expect(params.variables.brand).toHaveLength(2);
    expect(params.variables.brand[0]).toMatchObject({ name: "Acme SaaS" });
    expect(params.variables.brand[1]).toMatchObject({ name: "Northwind Agency" });
  });

  it("fixture C — caller-provided deadline survives the route untouched", async () => {
    await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send(FIXTURE_C)
      .expect(200);

    const [params] = mockGenerateExpertQuotePitch.mock.calls[0];
    expect((params.variables.request as { deadline: string }).deadline).toBe("next Tuesday");
  });

  it("accepts arbitrary JSON inside variables (no schema enforcement on inner shape)", async () => {
    await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send({
        variables: {
          brand: "Acme SaaS",
          request: { question: "Any thoughts?" },
          additionalContext: { tagline: "fast follow-up", priority: 1 },
        },
      })
      .expect(200);

    const [params] = mockGenerateExpertQuotePitch.mock.calls[0];
    expect(params.variables.brand).toBe("Acme SaaS");
    expect(params.variables.additionalContext).toEqual({ tagline: "fast follow-up", priority: 1 });
  });

  it("returns 400 with length-violation details when generator throws ExpertQuotePitchLengthError", async () => {
    const { ExpertQuotePitchLengthError } = await import("../../src/lib/chat-service-client.js");
    mockGenerateExpertQuotePitch.mockRejectedValueOnce(new ExpertQuotePitchLengthError(40, 100, 2500, 2, "too short pitch"));

    const res = await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send(FIXTURE_A)
      .expect(400);

    expect(res.body.error).toContain("outside the required range");
    expect(res.body.charCount).toBe(40);
    expect(res.body.minChars).toBe(100);
    expect(res.body.maxChars).toBe(2500);
    expect(res.body.attempts).toBe(2);
  });

  it("returns 400 when request body is invalid (missing variables)", async () => {
    const res = await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send({})
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when legacy `brand: {...}` body shape is sent (no fallback)", async () => {
    const res = await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send({ brand: { name: "Acme" }, request: { question: "?" } })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("returns 404 when expert-quote-pitch template is not registered", async () => {
    mockPromptFindFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send(FIXTURE_A)
      .expect(404);

    expect(res.body.error).toContain(EXPERT_QUOTE_PITCH_TYPE);
  });

  // --- Resolution order: explicit templateType ▸ feature assignment ▸ platform default ---

  it("explicit templateType overrides assignment + default (no assignment lookup)", async () => {
    await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send({ ...FIXTURE_A, templateType: "expert-quote-pitch-v9" })
      .expect(200);

    // templateType short-circuits resolution — assignment table is never consulted.
    expect(mockAssignmentFindFirst).not.toHaveBeenCalled();
    expect(mockPromptFindFirst).toHaveBeenCalledTimes(1);
  });

  it("no templateType + assignment present → consults the assignment table", async () => {
    mockAssignmentFindFirst.mockResolvedValue({
      featureSlug: "pr-expert-quote-opportunities",
      promptType: "expert-quote-pitch-v2",
    });

    await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .set("X-Feature-Slug", "pr-expert-quote-opportunities")
      .send({ ...FIXTURE_A, featureSlug: "pr-expert-quote-opportunities" })
      .expect(200);

    expect(mockAssignmentFindFirst).toHaveBeenCalledTimes(1);
  });

  it("no templateType + no assignment → falls back to platform default", async () => {
    await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send({ ...FIXTURE_A, featureSlug: "pr-expert-quote-opportunities" })
      .expect(200);

    expect(mockAssignmentFindFirst).toHaveBeenCalledTimes(1);
    expect(mockPromptFindFirst).toHaveBeenCalledTimes(1);
  });
});

describe("expert-quote-pitch template content", () => {
  it("declares all variables it references in EXPERT_QUOTE_PITCH_VARIABLES", () => {
    const referenced = new Set(
      Array.from(EXPERT_QUOTE_PITCH_TEMPLATE.matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1])
    );
    const declared = new Set(EXPERT_QUOTE_PITCH_VARIABLES.map((v) => v.name));
    for (const v of referenced) {
      expect(declared.has(v)).toBe(true);
    }
  });

  it("declares each variable with a name and a description", () => {
    for (const v of EXPERT_QUOTE_PITCH_VARIABLES) {
      expect(typeof v.name).toBe("string");
      expect(v.name.length).toBeGreaterThan(0);
      expect(typeof v.description).toBe("string");
      expect(v.description.length).toBeGreaterThan(0);
    }
  });

  it("documents multibrand input flexibility in variable descriptions", () => {
    const brandVar = EXPERT_QUOTE_PITCH_VARIABLES.find((v) => v.name === "brand");
    expect(brandVar).toBeDefined();
    expect(brandVar!.description.toLowerCase()).toMatch(/multibrand|array of brand|multiple brands/);
  });

  it("bans common AI-giveaway phrases in the prompt itself", () => {
    expect(EXPERT_QUOTE_PITCH_TEMPLATE).toContain("As an expert in");
    expect(EXPERT_QUOTE_PITCH_TEMPLATE).toContain("It's important to note");
    expect(EXPERT_QUOTE_PITCH_TEMPLATE).toContain("Featured.com");
  });

  it("instructs the model to land between 100 and 2500 characters", () => {
    expect(EXPERT_QUOTE_PITCH_TEMPLATE).toMatch(/100 and 2500 characters/);
  });

  it("instructs the model to speak as a collective when multiple brands are provided", () => {
    expect(EXPERT_QUOTE_PITCH_TEMPLATE).toMatch(/multiple brands|collective|never invent a single primary/i);
  });
});
