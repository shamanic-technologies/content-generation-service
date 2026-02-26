import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Cost tracking for content generation endpoints.
 *
 * Critical requirement: unlike the legacy /generate endpoint,
 * the /generate/content and /generate/calendar endpoints MUST fail
 * the entire request if cost tracking fails. No generation without cost tracking.
 */

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
    req.orgId = "org-internal-123";
    req.externalOrgId = req.headers["x-org-id"] || "org_test";
    next();
  },
}));

// Mock DB
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
      }),
    }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  contentGenerations: { id: { name: "id" } },
}));

// Mock key-client
vi.mock("../../src/lib/key-client.js", () => ({
  getByokKey: vi.fn().mockResolvedValue("fake-key"),
  getAppKey: vi.fn().mockResolvedValue("fake-key"),
}));

// Mock content-client
const MOCK_TOKENS_INPUT = 1200;
const MOCK_TOKENS_OUTPUT = 350;

vi.mock("../../src/lib/content-client.js", () => ({
  generateContent: vi.fn().mockResolvedValue({
    subject: "Test Subject",
    bodyHtml: "<p>Test body</p>",
    bodyText: "Test body",
    tokensInput: MOCK_TOKENS_INPUT,
    tokensOutput: MOCK_TOKENS_OUTPUT,
    promptRaw: "test prompt",
    responseRaw: {},
  }),
  generateCalendar: vi.fn().mockResolvedValue({
    title: "Test Event",
    description: "Description",
    location: null,
    tokensInput: MOCK_TOKENS_INPUT,
    tokensOutput: MOCK_TOKENS_OUTPUT,
    promptRaw: "test prompt",
    responseRaw: {},
  }),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

const CONTENT_BODY = {
  appId: "my-app",
  prompt: "Write an email",
  keyMode: "byok" as const,
};

const CALENDAR_BODY = {
  appId: "my-app",
  prompt: "Generate calendar event",
  keyMode: "byok" as const,
};

describe("Content generation cost tracking", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "run-456" });
    mockUpdateRun.mockResolvedValue({});
    mockAddCosts.mockResolvedValue({ costs: [] });

    app = createTestApp();
    const { default: contentRoutes } = await import("../../src/routes/content.js");
    app.use(contentRoutes);
  });

  // ─── /generate/content ─────────────────────────────────────────────────────

  it("should return 500 when createRun fails for /generate/content", async () => {
    mockCreateRun.mockRejectedValueOnce(new Error("runs-service unreachable"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send(CONTENT_BODY)
      .expect(500);

    expect(res.body.error).toContain("runs-service unreachable");

    errorSpy.mockRestore();
  });

  it("should return 500 when addCosts fails for /generate/content", async () => {
    mockAddCosts.mockRejectedValueOnce(new Error("Cost name not registered"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send(CONTENT_BODY)
      .expect(500);

    expect(res.body.error).toContain("Cost name not registered");

    errorSpy.mockRestore();
  });

  it("should use anthropic-sonnet-4.6 cost names for /generate/content", async () => {
    await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send(CONTENT_BODY)
      .expect(200);

    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    const [, costItems] = mockAddCosts.mock.calls[0];
    const costNames = costItems.map((c: { costName: string }) => c.costName);
    expect(costNames).toContain("anthropic-sonnet-4.6-tokens-input");
    expect(costNames).toContain("anthropic-sonnet-4.6-tokens-output");
  });

  it("should post raw token quantities for /generate/content", async () => {
    await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send(CONTENT_BODY)
      .expect(200);

    const [, costItems] = mockAddCosts.mock.calls[0];
    const inputCost = costItems.find((c: { costName: string }) => c.costName === "anthropic-sonnet-4.6-tokens-input");
    const outputCost = costItems.find((c: { costName: string }) => c.costName === "anthropic-sonnet-4.6-tokens-output");

    expect(inputCost.quantity).toBe(MOCK_TOKENS_INPUT);
    expect(outputCost.quantity).toBe(MOCK_TOKENS_OUTPUT);
    expect(Number.isInteger(inputCost.quantity)).toBe(true);
  });

  // ─── /generate/calendar ────────────────────────────────────────────────────

  it("should return 500 when createRun fails for /generate/calendar", async () => {
    mockCreateRun.mockRejectedValueOnce(new Error("runs-service unreachable"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/generate/calendar")
      .set("X-Org-Id", "org_test")
      .send(CALENDAR_BODY)
      .expect(500);

    expect(res.body.error).toContain("runs-service unreachable");

    errorSpy.mockRestore();
  });

  it("should return 500 when addCosts fails for /generate/calendar", async () => {
    mockAddCosts.mockRejectedValueOnce(new Error("Cost name not registered"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/generate/calendar")
      .set("X-Org-Id", "org_test")
      .send(CALENDAR_BODY)
      .expect(500);

    expect(res.body.error).toContain("Cost name not registered");

    errorSpy.mockRestore();
  });

  it("should use anthropic-sonnet-4.6 cost names for /generate/calendar", async () => {
    await request(app)
      .post("/generate/calendar")
      .set("X-Org-Id", "org_test")
      .send(CALENDAR_BODY)
      .expect(200);

    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    const [, costItems] = mockAddCosts.mock.calls[0];
    const costNames = costItems.map((c: { costName: string }) => c.costName);
    expect(costNames).toContain("anthropic-sonnet-4.6-tokens-input");
    expect(costNames).toContain("anthropic-sonnet-4.6-tokens-output");
  });
});
