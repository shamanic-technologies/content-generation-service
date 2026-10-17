import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// BLIND-WRITER-1017, need 3: a blind-type template whose text licenses naming the client
// cannot be stored; a clean one can. The real guard runs; chat-service Jev is faked at the
// fetch boundary: the blind question answers yes when the passage licenses the client name.

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "11111111-1111-1111-1111-111111111111";
    req.userId = "22222222-2222-2222-2222-222222222222";
    req.runId = "33333333-3333-3333-3333-333333333333";
    next();
  },
}));

const NOW = new Date("2026-10-17T00:00:00Z");
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

const blindCalls: any[] = [];

function fakeJev() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const answers: Record<string, unknown> = {};
    let blind = false;
    for (const [k, q] of Object.entries<any>(body.questions)) {
      const passage = q.instructions.split('"""')[1];
      if (/ANONYMOUS/.test(q.instructions)) {
        blind = true;
        answers[k] = { type: "noul", noul: /client name if recognizable/.test(passage) ? 0.82 : 0.05 };
      } else {
        answers[k] = { type: "noul", noul: 0.03 };
      }
    }
    if (blind) blindCalls.push(body);
    return new Response(
      JSON.stringify({ model: "jev-latest", answers, usage: { inputTokens: 500, outputTokens: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

const LICENSING = [
  "Write a short cold email to {{leadFirstName}}.",
  "Subject line: use the offering angle, a data point, or the client name if recognizable.",
  "## Brand Intelligence (internal only: never reveal the client name or URL)",
  "{{brandExtractedFields}}",
].join("\n");
const CLEAN = [
  "Write a short cold email to {{leadFirstName}}.",
  "Subject line: use the offering angle or a data point.",
  "## Brand Intelligence (internal only: never reveal the client name or URL)",
  "{{brandExtractedFields}}",
].join("\n");
const VARS = [
  { name: "leadFirstName", description: "The recipient's first name" },
  { name: "brandExtractedFields", description: "What the client sells" },
];

describe("blind templates at write", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    blindCalls.length = 0;
    vi.stubGlobal("fetch", fakeJev());
    mockPromptFindFirst.mockResolvedValue(undefined);
    mockJudgmentFindFirst.mockResolvedValue(undefined);
    mockJudgmentInsert.mockResolvedValue(undefined);
    mockPromptReturning.mockImplementation((v: any) => [{ id: "p1", ...v, createdAt: NOW, updatedAt: NOW }]);
    app = express();
    app.use(express.json());
    const { default: routes } = await import("../../src/routes/prompts.js");
    app.use(routes);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("refuses a blind template that says to use the client name if recognizable, citing it", async () => {
    const res = await request(app)
      .post("/prompts")
      .send({ type: "blind-discovery-email-v99", prompt: LICENSING, variables: VARS })
      .expect(422);
    expect(res.body.code).toBe("BLIND_TEMPLATE_REVEALS_CLIENT");
    expect(res.body.passages).toEqual([
      {
        passage: "Subject line: use the offering angle, a data point, or the client name if recognizable.",
        location: "prompt",
        probability: 0.82,
      },
    ]);
    expect(mockPromptReturning).not.toHaveBeenCalled();
    // Persisted under the blind rule's own version, so a resubmission costs nothing.
    expect(mockJudgmentInsert).toHaveBeenCalledWith(expect.objectContaining({ ruleVersion: "blind-1", neutral: false }));
  });

  it("stores a clean blind template", async () => {
    await request(app)
      .post("/prompts")
      .send({ type: "feedback-request-blind-email-v9", prompt: CLEAN, variables: VARS })
      .expect(201);
    expect(blindCalls).toHaveLength(1);
    expect(mockPromptReturning).toHaveBeenCalledTimes(1);
  });

  it("does not apply the blind rule to a named or offer template", async () => {
    await request(app)
      .post("/platform-prompts")
      .send({ type: "cold-email-v99", prompt: LICENSING, variables: VARS })
      .expect(201);
    expect(blindCalls).toHaveLength(0);
  });

  it("refuses an upgrade that keeps an inherited licensing passage, accepts it once deleted", async () => {
    const source = { id: "p34", orgId: null, type: "blind-discovery-email-v34", prompt: LICENSING, variables: VARS, createdAt: NOW, updatedAt: NOW };
    mockPromptFindFirst.mockResolvedValue(source);
    const { db } = await import("../../src/db/index.js");
    (db.query.prompts.findMany as any).mockResolvedValue([{ type: "blind-discovery-email-v34" }]);

    const kept = await request(app)
      .put("/prompts")
      .send({ sourceType: "blind-discovery-email-v34", prompt: `${LICENSING}\nKeep it short.`, variables: VARS })
      .expect(422);
    expect(kept.body.code).toBe("BLIND_TEMPLATE_REVEALS_CLIENT");

    const cleaned = await request(app)
      .put("/prompts")
      .send({ sourceType: "blind-discovery-email-v34", prompt: CLEAN, variables: VARS })
      .expect(201);
    expect(cleaned.body.type).toBe("blind-discovery-email-v35");
  });

  it("answers a resubmission from the stored verdict", async () => {
    mockJudgmentFindFirst.mockImplementation(async () => ({
      neutral: false,
      passages: [{ text: "Subject line: use the client name if recognizable.", location: "prompt", probability: 0.82 }],
    }));
    const res = await request(app)
      .post("/prompts")
      .send({ type: "blind-discovery-email-v99", prompt: LICENSING, variables: VARS })
      .expect(422);
    // The stored neutrality verdict lists the same passage: the first check to read it refuses.
    expect(res.status).toBe(422);
  });
});
