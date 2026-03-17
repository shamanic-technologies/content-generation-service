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
    req.orgId = req.headers["x-org-id"] || "org-123";
    req.userId = req.headers["x-user-id"] || "user-456";
    req.runId = req.headers["x-run-id"] || "run-789";
    next();
  },
}));

// Track prompt lookups
const mockPromptFindFirst = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      prompts: {
        findFirst: (...args: unknown[]) => mockPromptFindFirst(...args),
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailGenerations: { id: { name: "id" } },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

vi.mock("../../src/lib/key-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "fake-key", keySource: "platform" as const }),
}));

const mockGenerateFromTemplate = vi.fn().mockResolvedValue({
  subject: "Test subject",
  sequence: [{ step: 1, bodyHtml: "<p>Test</p>", bodyText: "Test", daysSinceLastStep: 0 }],
  tokensInput: 100,
  tokensOutput: 50,
  costUsd: 0.001,
  promptRaw: "test",
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

describe("POST /generate prompt lookup", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-456" });

    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("uses prompt found by type (globally unique)", async () => {
    const prompt = {
      id: "prompt-1",
      orgId: null,
      type: "cold-email",
      prompt: "Prompt for {{name}}",
      variables: ["name"],
    };

    mockPromptFindFirst.mockResolvedValueOnce(prompt);

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .send({ type: "cold-email", variables: { name: "John" } })
      .expect(200);

    // Single lookup — no fallback
    expect(mockPromptFindFirst).toHaveBeenCalledTimes(1);
    expect(mockGenerateFromTemplate).toHaveBeenCalledWith(
      "fake-key",
      expect.objectContaining({
        promptTemplate: "Prompt for {{name}}",
      })
    );
  });

  it("returns 404 when prompt not found", async () => {
    mockPromptFindFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .send({ type: "cold-email", variables: { name: "John" } })
      .expect(404);

    expect(res.body.error).toContain("No prompt found");
    expect(res.body.error).toContain("POST /prompts");
  });
});
