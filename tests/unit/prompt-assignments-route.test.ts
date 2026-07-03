import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  EXPERT_QUOTE_PITCH_TYPE,
  EXPERT_QUOTE_PITCH_TEMPLATE,
  EXPERT_QUOTE_PITCH_VARIABLES,
} from "../../src/lib/expert-quote-pitch-template.js";

// Auth: x-org-id + x-user-id required, x-run-id optional.
vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuthRunOptional: (req: any, res: any, next: any) => {
    if (!req.headers["x-org-id"]) return res.status(400).json({ error: "x-org-id header required" });
    if (!req.headers["x-user-id"]) return res.status(400).json({ error: "x-user-id header required" });
    req.orgId = req.headers["x-org-id"];
    req.userId = req.headers["x-user-id"];
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    next();
  },
}));

const mockPromptFindFirst = vi.fn();
const mockPromptFindMany = vi.fn();
const mockAssignmentFindFirst = vi.fn();
const mockReturning = vi.fn();
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
const mockValues = vi.fn().mockReturnValue({ returning: mockReturning, onConflictDoUpdate: mockOnConflictDoUpdate });
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    query: {
      prompts: {
        findFirst: (...args: unknown[]) => mockPromptFindFirst(...args),
        findMany: (...args: unknown[]) => mockPromptFindMany(...args),
      },
      featurePromptAssignment: { findFirst: (...args: unknown[]) => mockAssignmentFindFirst(...args) },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  prompts: { type: { name: "type" }, orgId: { name: "org_id" } },
  featurePromptAssignment: {
    featureSlug: { name: "feature_slug" },
    promptType: { name: "prompt_type" },
    updatedAt: { name: "updated_at" },
  },
}));

const SOURCE_ROW = {
  id: "p-default",
  orgId: null,
  type: EXPERT_QUOTE_PITCH_TYPE,
  prompt: EXPERT_QUOTE_PITCH_TEMPLATE,
  variables: EXPERT_QUOTE_PITCH_VARIABLES,
  createdAt: new Date("2025-01-15T00:00:00Z"),
  updatedAt: new Date("2025-01-15T00:00:00Z"),
};

// The full declared token set for the expert-quote-pitch source template.
const ALL_TOKENS = "{{expert}} {{brands}} {{journalistRequest}}";

// A valid edited prompt that keeps the full declared token set.
const EDITED_PROMPT = `EDITED expert pitch.\n${ALL_TOKENS}\nReturn ONLY the pitch.`;

function makeApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("GET /prompt-assignments", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPromptFindFirst.mockResolvedValue(SOURCE_ROW);
    app = makeApp();
    const { default: routes } = await import("../../src/routes/prompt-assignments.js");
    app.use(routes);
  });

  it("no override → returns platform default text + isDefault:true", async () => {
    mockAssignmentFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/prompt-assignments?featureSlug=pr-expert-quote-opportunities")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .expect(200);

    expect(res.body.featureSlug).toBe("pr-expert-quote-opportunities");
    expect(res.body.promptType).toBe(EXPERT_QUOTE_PITCH_TYPE);
    expect(res.body.prompt).toBe(EXPERT_QUOTE_PITCH_TEMPLATE);
    expect(res.body.variables).toEqual(EXPERT_QUOTE_PITCH_VARIABLES);
    expect(res.body.isDefault).toBe(true);
  });

  it("assignment → v2 returns the fork + isDefault:false", async () => {
    mockAssignmentFindFirst.mockResolvedValue({
      featureSlug: "pr-expert-quote-opportunities",
      promptType: "expert-quote-pitch-v2",
    });
    mockPromptFindFirst.mockResolvedValue({
      ...SOURCE_ROW,
      id: "p-v2",
      type: "expert-quote-pitch-v2",
      prompt: `v2 body ${ALL_TOKENS}`,
    });

    const res = await request(app)
      .get("/prompt-assignments?featureSlug=pr-expert-quote-opportunities")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .expect(200);

    expect(res.body.promptType).toBe("expert-quote-pitch-v2");
    expect(res.body.isDefault).toBe(false);
  });

  it("returns 400 when featureSlug query param missing", async () => {
    await request(app)
      .get("/prompt-assignments")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .expect(400);
  });

  it("returns 400 when x-org-id header missing", async () => {
    await request(app)
      .get("/prompt-assignments?featureSlug=pr-expert-quote-opportunities")
      .set("X-User-Id", "user-1")
      .expect(400);
  });
});

describe("PUT /prompt-assignments", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAssignmentFindFirst.mockResolvedValue(null); // resolves to platform default source
    mockPromptFindFirst.mockResolvedValue(SOURCE_ROW);
    mockPromptFindMany.mockResolvedValue([]); // no existing versions → v2
    mockReturning.mockResolvedValue([
      {
        ...SOURCE_ROW,
        id: "p-v2",
        orgId: "org-1",
        type: "expert-quote-pitch-v2",
        prompt: EDITED_PROMPT,
        variables: EXPERT_QUOTE_PITCH_VARIABLES,
      },
    ]);
    app = makeApp();
    const { default: routes } = await import("../../src/routes/prompt-assignments.js");
    app.use(routes);
  });

  it("valid edit → forks expert-quote-pitch-v2 and reassigns the feature", async () => {
    const res = await request(app)
      .put("/prompt-assignments")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .send({
        featureSlug: "pr-expert-quote-opportunities",
        prompt: EDITED_PROMPT,
        variables: EXPERT_QUOTE_PITCH_VARIABLES,
      })
      .expect(200);

    expect(res.body.featureSlug).toBe("pr-expert-quote-opportunities");
    expect(res.body.promptType).toBe("expert-quote-pitch-v2");
    expect(res.body.prompt).toBe(EDITED_PROMPT);

    // forked the prompt (returning) AND upserted the assignment (onConflictDoUpdate)
    expect(mockReturning).toHaveBeenCalledTimes(1);
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    const upsertValues = mockValues.mock.calls.find((c) => c[0]?.featureSlug)?.[0];
    expect(upsertValues).toMatchObject({ featureSlug: "pr-expert-quote-opportunities", promptType: "expert-quote-pitch-v2" });
  });

  it("succeeds without x-run-id (run optional)", async () => {
    await request(app)
      .put("/prompt-assignments")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .send({
        featureSlug: "pr-expert-quote-opportunities",
        prompt: EDITED_PROMPT,
        variables: EXPERT_QUOTE_PITCH_VARIABLES,
      })
      .expect(200);
  });

  it("dropping a {{var}} → 400 naming the var, no fork, no assignment", async () => {
    // drops journalistRequest
    const droppedPrompt = "EDITED {{expert}} {{brands}}";

    const res = await request(app)
      .put("/prompt-assignments")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .send({
        featureSlug: "pr-expert-quote-opportunities",
        prompt: droppedPrompt,
        variables: EXPERT_QUOTE_PITCH_VARIABLES,
      })
      .expect(400);

    expect(res.body.error).toContain("journalistRequest");
    expect(mockReturning).not.toHaveBeenCalled();
    expect(mockOnConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("adding a {{var}} → 400 naming the var, no fork, no assignment", async () => {
    const addedPrompt = `EDITED ${ALL_TOKENS} {{rogue}}`;

    const res = await request(app)
      .put("/prompt-assignments")
      .set("X-Org-Id", "org-1")
      .set("X-User-Id", "user-1")
      .send({
        featureSlug: "pr-expert-quote-opportunities",
        prompt: addedPrompt,
        variables: EXPERT_QUOTE_PITCH_VARIABLES,
      })
      .expect(400);

    expect(res.body.error).toContain("rogue");
    expect(mockReturning).not.toHaveBeenCalled();
    expect(mockOnConflictDoUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 when org/user headers missing", async () => {
    await request(app)
      .put("/prompt-assignments")
      .send({ featureSlug: "x", prompt: EDITED_PROMPT, variables: EXPERT_QUOTE_PITCH_VARIABLES })
      .expect(400);
  });
});
