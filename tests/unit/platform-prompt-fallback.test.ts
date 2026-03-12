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

// Track prompt lookups — returns different results based on call count
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

describe("POST /generate platform prompt fallback", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-456" });

    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("uses org-specific prompt when available (no fallback)", async () => {
    const orgPrompt = {
      id: "prompt-org",
      orgId: "org-123",
      type: "cold-email",
      prompt: "Org-specific prompt for {{name}}",
      variables: ["name"],
    };

    // First call (org lookup) → found
    mockPromptFindFirst.mockResolvedValueOnce(orgPrompt);

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .send({ type: "cold-email", variables: { name: "John" } })
      .expect(200);

    // Should only call findFirst once (org lookup found it)
    expect(mockPromptFindFirst).toHaveBeenCalledTimes(1);
    expect(mockGenerateFromTemplate).toHaveBeenCalledWith(
      "fake-key",
      expect.objectContaining({
        promptTemplate: "Org-specific prompt for {{name}}",
      })
    );
  });

  it("falls back to platform prompt when org has none", async () => {
    const platformPrompt = {
      id: "prompt-platform",
      orgId: null,
      type: "cold-email",
      prompt: "Platform default prompt for {{name}}",
      variables: ["name"],
    };

    // First call (org lookup) → not found
    mockPromptFindFirst.mockResolvedValueOnce(null);
    // Second call (platform fallback) → found
    mockPromptFindFirst.mockResolvedValueOnce(platformPrompt);

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .send({ type: "cold-email", variables: { name: "John" } })
      .expect(200);

    expect(mockPromptFindFirst).toHaveBeenCalledTimes(2);
    expect(mockGenerateFromTemplate).toHaveBeenCalledWith(
      "fake-key",
      expect.objectContaining({
        promptTemplate: "Platform default prompt for {{name}}",
      })
    );
  });

  it("returns 404 when neither org nor platform prompt exists", async () => {
    mockPromptFindFirst.mockResolvedValueOnce(null); // org
    mockPromptFindFirst.mockResolvedValueOnce(null); // platform

    const res = await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .send({ type: "cold-email", variables: { name: "John" } })
      .expect(404);

    expect(res.body.error).toContain("No prompt found");
    expect(res.body.error).toContain("PUT /platform-prompts");
  });

  it("org prompt takes priority over platform prompt", async () => {
    const orgPrompt = {
      id: "prompt-org",
      orgId: "org-123",
      type: "cold-email",
      prompt: "Custom org prompt",
      variables: [],
    };

    // Org lookup → found (platform never queried)
    mockPromptFindFirst.mockResolvedValueOnce(orgPrompt);

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-123")
      .set("X-User-Id", "user-456")
      .send({ type: "cold-email", variables: {} })
      .expect(200);

    // Only 1 DB call — no fallback needed
    expect(mockPromptFindFirst).toHaveBeenCalledTimes(1);
    expect(mockGenerateFromTemplate).toHaveBeenCalledWith(
      "fake-key",
      expect.objectContaining({
        promptTemplate: "Custom org prompt",
      })
    );
  });
});
