import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock runs-client
const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-456" });
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

// Mock auth middleware
vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-internal-123";
    req.userId = req.headers["x-user-id"] || "user-internal-456";
    req.runId = req.headers["x-run-id"] || "run-caller-123";
    next();
  },
}));

// Mock DB
const mockPromptFindFirst = vi.fn();
const mockGenFindFirst = vi.fn();
const mockInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
  }),
});

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      prompts: {
        findFirst: (...args: unknown[]) => mockPromptFindFirst(...args),
      },
      emailGenerations: {
        findFirst: (...args: unknown[]) => mockGenFindFirst(...args),
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailGenerations: {
    id: { name: "id" },
    orgId: { name: "org_id" },
    idempotencyKey: { name: "idempotency_key" },
  },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

vi.mock("../../src/lib/key-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "fake-anthropic-key", keySource: "platform" as const }),
}));

const mockGenerateFromTemplate = vi.fn().mockResolvedValue({
  subject: "Fresh subject",
  sequence: [
    { step: 1, bodyHtml: "<p>Fresh body</p>", bodyText: "Fresh body", daysSinceLastStep: 0 },
    { step: 2, bodyHtml: "<p>Follow-up 1</p>", bodyText: "Follow-up 1", daysSinceLastStep: 3 },
    { step: 3, bodyHtml: "<p>Follow-up 2</p>", bodyText: "Follow-up 2", daysSinceLastStep: 7 },
  ],
  tokensInput: 500,
  tokensOutput: 100,
  costUsd: 0.005,
  promptRaw: "resolved prompt",
  responseRaw: {},
});

vi.mock("../../src/lib/anthropic-client.js", () => ({
  generateFromTemplate: (...args: unknown[]) => mockGenerateFromTemplate(...args),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

const validBody = {
  type: "email",
  variables: { recipientInfo: "John Doe", senderInfo: "MyBrand" },
};

describe("POST /generate idempotency", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-456" });
    mockPromptFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: "org-internal-123",
      type: "email",
      prompt: "Write an email.\n\n{{recipientInfo}}\n\n{{senderInfo}}",
      variables: ["recipientInfo", "senderInfo"],
    });
    mockGenFindFirst.mockResolvedValue(null);
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
      }),
    });

    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("returns cached result when idempotencyKey matches an existing generation", async () => {
    mockGenFindFirst.mockResolvedValue({
      id: "cached-gen-id",
      subject: "Cached subject",
      sequence: [
        { step: 1, bodyHtml: "<p>Cached</p>", bodyText: "Cached", daysSinceLastStep: 0 },
        { step: 2, bodyHtml: "<p>Cached f1</p>", bodyText: "Cached f1", daysSinceLastStep: 3 },
        { step: 3, bodyHtml: "<p>Cached f2</p>", bodyText: "Cached f2", daysSinceLastStep: 7 },
      ],
      tokensInput: 400,
      tokensOutput: 80,
    });

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, idempotencyKey: "idem-key-1" })
      .expect(200);

    expect(res.body.id).toBe("cached-gen-id");
    expect(res.body.subject).toBe("Cached subject");
    expect(res.body.tokensInput).toBe(400);

    // Claude should NOT be called
    expect(mockGenerateFromTemplate).not.toHaveBeenCalled();
    // DB insert should NOT happen
    expect(mockInsert).not.toHaveBeenCalled();
    // Runs-service should NOT be called
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("generates normally when idempotencyKey has no match", async () => {
    mockGenFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({ ...validBody, idempotencyKey: "idem-key-new" })
      .expect(200);

    expect(res.body.id).toBe("gen-789");
    expect(res.body.subject).toBe("Fresh subject");
    expect(res.body.sequence).toHaveLength(3);

    // Claude SHOULD be called
    expect(mockGenerateFromTemplate).toHaveBeenCalledOnce();
    // DB insert SHOULD happen
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("generates normally when no idempotencyKey is provided (backward compat)", async () => {
    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send(validBody) // no idempotencyKey
      .expect(200);

    expect(res.body.id).toBe("gen-789");
    expect(res.body.subject).toBe("Fresh subject");
    expect(res.body.sequence).toHaveLength(3);

    // Idempotency lookup should NOT be called
    expect(mockGenFindFirst).not.toHaveBeenCalled();
    // Normal flow should proceed
    expect(mockGenerateFromTemplate).toHaveBeenCalledOnce();
    expect(mockInsert).toHaveBeenCalledOnce();
  });
});
