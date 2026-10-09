import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// The AC: a template whose fixed text names a specific company/offer is refused
// with the passage cited; the same template with that passage turned into a
// declared variable is stored. The real guard runs; chat-service Jev is faked
// at the fetch boundary (it judges a passage specific when it names Acme).

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "11111111-1111-1111-1111-111111111111";
    req.userId = "22222222-2222-2222-2222-222222222222";
    req.runId = "33333333-3333-3333-3333-333333333333";
    next();
  },
}));

const NOW = new Date("2026-10-09T00:00:00Z");
const mockPromptFindFirst = vi.fn();
const mockJudgmentFindFirst = vi.fn();
const mockPromptReturning = vi.fn();
const mockJudgmentInsert = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (table: { __name: string }) => ({
      values: (v: Record<string, unknown>) =>
        table.__name === "template_neutrality_judgments"
          ? { onConflictDoNothing: () => mockJudgmentInsert(v) }
          : { returning: () => mockPromptReturning(v) },
    }),
    query: {
      prompts: { findFirst: (...a: unknown[]) => mockPromptFindFirst(...a), findMany: vi.fn() },
      templateNeutralityJudgments: { findFirst: (...a: unknown[]) => mockJudgmentFindFirst(...a) },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  prompts: { __name: "prompts", type: { name: "type" }, orgId: { name: "org_id" } },
  templateNeutralityJudgments: { __name: "template_neutrality_judgments", contentKey: { name: "content_key" } },
}));

const fetchCalls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];

function fakeJev() {
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    fetchCalls.push({ url, headers: init.headers as Record<string, string>, body });
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries<any>(body.questions)) {
      const passage = q.instructions.split('"""')[1];
      answers[k] = { type: "noul", noul: /Acme/.test(passage) ? 0.97 : 0.03 };
    }
    return new Response(
      JSON.stringify({ model: "jev-latest", answers, usage: { inputTokens: 900, outputTokens: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

const SPECIFIC = [
  "Write a short cold email to {{leadFirstName}}.",
  "Pitch Acme's free 14-day SEO audit as the ask.",
  "Keep it under 120 words.",
].join("\n");

const NEUTRAL = [
  "Write a short cold email to {{leadFirstName}}.",
  "Pitch {{offerName}} as the ask.",
  "Keep it under 120 words.",
].join("\n");

const VARS = [{ name: "leadFirstName", description: "The recipient's first name" }];
const NEUTRAL_VARS = [...VARS, { name: "offerName", description: "The offer the brand gives for free" }];

describe("template neutrality on POST /prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchCalls.length = 0;
    vi.stubGlobal("fetch", fakeJev());
    mockPromptFindFirst.mockResolvedValue(undefined);
    mockJudgmentFindFirst.mockResolvedValue(undefined);
    mockJudgmentInsert.mockResolvedValue(undefined);
    mockPromptReturning.mockImplementation((v: any) => [
      { id: "p1", ...v, createdAt: NOW, updatedAt: NOW },
    ]);
    app = express();
    app.use(express.json());
    const { default: routes } = await import("../../src/routes/prompts.js");
    app.use(routes);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("refuses a template naming a specific company/offer, citing the passage, and stores nothing", async () => {
    const res = await request(app)
      .post("/prompts")
      .send({ type: "copilot-cold-email", prompt: SPECIFIC, variables: VARS })
      .expect(422);

    expect(res.body.code).toBe("TEMPLATE_NOT_NEUTRAL");
    expect(res.body.passages).toEqual([
      { passage: "Pitch Acme's free 14-day SEO audit as the ask.", location: "prompt", probability: 0.97 },
    ]);
    expect(res.body.error).toMatch(/\{\{variable\}\}/);
    expect(mockPromptReturning).not.toHaveBeenCalled();

    // Judged through chat-service Jev, org-billed under the inbound identity.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toMatch(/\/orgs\/judgments$/);
    expect(fetchCalls[0].headers["x-org-id"]).toBe("11111111-1111-1111-1111-111111111111");
    expect(fetchCalls[0].headers["x-run-id"]).toBe("33333333-3333-3333-3333-333333333333");
    expect(fetchCalls[0].body.state).toBe(SPECIFIC);

    // The verdict is persisted so the same content is never judged twice.
    expect(mockJudgmentInsert).toHaveBeenCalledWith(
      expect.objectContaining({ neutral: false, model: "jev-latest", inputTokens: 900 }),
    );
  });

  it("stores the same template once the passage is a declared variable", async () => {
    const res = await request(app)
      .post("/prompts")
      .send({ type: "copilot-cold-email", prompt: NEUTRAL, variables: NEUTRAL_VARS })
      .expect(201);

    expect(res.body.prompt).toBe(NEUTRAL);
    expect(mockPromptReturning).toHaveBeenCalledTimes(1);
    expect(mockJudgmentInsert).toHaveBeenCalledWith(expect.objectContaining({ neutral: true }));
  });

  it("answers a resubmission from the stored verdict without calling chat-service", async () => {
    mockJudgmentFindFirst.mockResolvedValue({
      neutral: false,
      passages: [{ text: "Pitch Acme's free 14-day SEO audit as the ask.", location: "prompt", probability: 0.97 }],
    });
    const res = await request(app)
      .post("/prompts")
      .send({ type: "copilot-cold-email", prompt: SPECIFIC, variables: VARS })
      .expect(422);
    expect(res.body.passages).toHaveLength(1);
    expect(fetchCalls).toHaveLength(0);
  });

  it("does not judge when nothing is stored (type already exists)", async () => {
    mockPromptFindFirst.mockResolvedValue({
      id: "p0", type: "copilot-cold-email", prompt: SPECIFIC, variables: VARS, createdAt: NOW, updatedAt: NOW,
    });
    await request(app)
      .post("/prompts")
      .send({ type: "copilot-cold-email", prompt: SPECIFIC, variables: VARS })
      .expect(200);
    expect(fetchCalls).toHaveLength(0);
  });

  it("fails loud and stores nothing when chat-service is out of credits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"Insufficient credits"}', { status: 402 })));
    const res = await request(app)
      .post("/prompts")
      .send({ type: "copilot-cold-email", prompt: NEUTRAL, variables: NEUTRAL_VARS })
      .expect(402);
    expect(res.body.code).toBe("TEMPLATE_NEUTRALITY_CHECK_FAILED");
    expect(mockPromptReturning).not.toHaveBeenCalled();
  });

  it("judges a platform template write on the platform tier", async () => {
    await request(app)
      .post("/platform-prompts")
      .send({ type: "copilot-cold-email", prompt: NEUTRAL, variables: NEUTRAL_VARS })
      .expect(201);
    expect(fetchCalls[0].url).toMatch(/\/internal\/platform-judgments$/);
    expect(fetchCalls[0].headers["x-org-id"]).toBeUndefined();
  });
});
