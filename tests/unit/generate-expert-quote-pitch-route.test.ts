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
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  prompts: { type: { name: "type" }, orgId: { name: "org_id" } },
  emailGenerations: { id: { name: "id" } },
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
};

const FIXTURE_B = {
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
};

const FIXTURE_C = {
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
};

describe("POST /generate-expert-quote-pitch", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
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

  it("fixture B — agency owner — passes nested brand/request fields to template variables", async () => {
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
    expect(params.variables).toMatchObject({
      brandName: "Northwind Agency",
      brandIndustry: "Marketing services",
      brandExpertise: "content strategy for fintech",
      brandVoice: "warm, specific, slightly contrarian",
      brandTargetAudience: "fintech CMOs",
      requestQuestion: FIXTURE_B.request.question,
      requestMediaOutlet: "Modern Marketer",
      requestSource: "Sam Reporter",
      requestDeadline: "not specified",
      additionalContext: FIXTURE_B.additionalContext,
    });
  });

  it("fixture C — DTC ecommerce — passes deadline through when provided", async () => {
    await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send(FIXTURE_C)
      .expect(200);

    const [params] = mockGenerateExpertQuotePitch.mock.calls[0];
    expect(params.variables.requestDeadline).toBe("next Tuesday");
    expect(params.variables.additionalContext).toBe("(none)");
  });

  it("accepts null mediaOutlet and source, substitutes 'not specified' in template variables", async () => {
    await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send({
        brand: FIXTURE_A.brand,
        request: {
          question: FIXTURE_A.request.question,
          mediaOutlet: null,
          source: null,
        },
      })
      .expect(200);

    const [params] = mockGenerateExpertQuotePitch.mock.calls[0];
    expect(params.variables.requestMediaOutlet).toBe("not specified");
    expect(params.variables.requestSource).toBe("not specified");
  });

  it("accepts omitted mediaOutlet and source, substitutes 'not specified' in template variables", async () => {
    await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send({
        brand: FIXTURE_A.brand,
        request: { question: FIXTURE_A.request.question },
      })
      .expect(200);

    const [params] = mockGenerateExpertQuotePitch.mock.calls[0];
    expect(params.variables.requestMediaOutlet).toBe("not specified");
    expect(params.variables.requestSource).toBe("not specified");
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

  it("returns 400 when request body is invalid", async () => {
    const res = await request(app)
      .post("/generate-expert-quote-pitch")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .set("X-Run-Id", "run-1")
      .send({ brand: { name: "Acme" } })
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
});

describe("expert-quote-pitch template content", () => {
  it("declares all variables it references in EXPERT_QUOTE_PITCH_VARIABLES", () => {
    const referenced = new Set(
      Array.from(EXPERT_QUOTE_PITCH_TEMPLATE.matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1])
    );
    for (const v of referenced) {
      expect(EXPERT_QUOTE_PITCH_VARIABLES).toContain(v);
    }
  });

  it("bans common AI-giveaway phrases in the prompt itself", () => {
    expect(EXPERT_QUOTE_PITCH_TEMPLATE).toContain("As an expert in");
    expect(EXPERT_QUOTE_PITCH_TEMPLATE).toContain("It's important to note");
    expect(EXPERT_QUOTE_PITCH_TEMPLATE).toContain("Featured.com");
  });

  it("instructs the model to land between 100 and 2500 characters", () => {
    expect(EXPERT_QUOTE_PITCH_TEMPLATE).toMatch(/100 and 2500 characters/);
  });
});
