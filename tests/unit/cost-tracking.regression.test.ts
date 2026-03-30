import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Regression test: email generation run tracking
 *
 * After migrating to chat-service, LLM cost tracking is handled by chat-service.
 * Content-generation-service still creates a child run for linking to the email record.
 *
 * These tests verify:
 * - A child run is created in runs-service for each generation
 * - The generationRunId is linked to the DB record
 * - Run tracking failures are logged at error level
 */

// Mock runs-client before importing the route
const mockCreateRun = vi.fn().mockResolvedValue({ id: "run-456" });
const mockUpdateRun = vi.fn().mockResolvedValue({});

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
}));

// Mock auth middleware to pass through
vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-internal-123";
    req.userId = req.headers["x-user-id"] || "user-internal-456";
    req.runId = req.headers["x-run-id"] || "run-caller-123";
    next();
  },
}));

// Mock the DB — track db.update().set() calls to verify generationRunId linking
const mockDbSetCalls: Array<Record<string, unknown>> = [];

// Mock prompts lookup to return a stored prompt
const MOCK_PROMPT_TEMPLATE = "Write an email to {{recipientName}} about {{senderName}}";

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "gen-789" }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        mockDbSetCalls.push(data);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    query: {
      prompts: {
        findFirst: vi.fn().mockResolvedValue({
          id: "prompt-1",
          orgId: "org-internal-123",
          type: "email",
          prompt: MOCK_PROMPT_TEMPLATE,
          variables: ["recipientName", "senderName"],
        }),
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  emailGenerations: { id: { name: "id" } },
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

vi.mock("../../src/lib/campaign-client.js", () => ({
  getCampaignFeatureInputs: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn().mockResolvedValue(new Map()),
}));

// Mock anthropic client (now backed by chat-service)
const MOCK_TOKENS_INPUT = 1500;
const MOCK_TOKENS_OUTPUT = 300;
vi.mock("../../src/lib/anthropic-client.js", () => ({
  generateFromTemplate: vi.fn().mockResolvedValue({
    subject: "Test subject",
    sequence: [
      { step: 1, bodyHtml: "<p>Test body</p>", bodyText: "Test body", daysSinceLastStep: 0 },
      { step: 2, bodyHtml: "<p>Follow-up 1</p>", bodyText: "Follow-up 1", daysSinceLastStep: 3 },
      { step: 3, bodyHtml: "<p>Follow-up 2</p>", bodyText: "Follow-up 2", daysSinceLastStep: 7 },
    ],
    tokensInput: MOCK_TOKENS_INPUT,
    tokensOutput: MOCK_TOKENS_OUTPUT,
    model: "claude-sonnet-4-6",
    promptRaw: "test prompt",
    responseRaw: {},
  }),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    status = 402;
    balance_cents: number;
    required_cents: number;
    constructor(balance_cents: number, required_cents: number) {
      super("Insufficient credits");
      this.balance_cents = balance_cents;
      this.required_cents = required_cents;
    }
  },
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

const VALID_REQUEST = {
  type: "email",
  variables: { recipientName: "John at Acme", senderName: "MyCompany" },
};

describe("Email generation run tracking", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbSetCalls.length = 0;
    mockCreateRun.mockResolvedValue({ id: "run-456" });
    mockUpdateRun.mockResolvedValue({});

    app = createTestApp();
    const { default: generateRoutes } = await import("../../src/routes/generate.js");
    app.use(generateRoutes);
  });

  it("should create child run with x-run-id header as parentRunId via identity headers", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .set("X-Run-Id", "campaign-run-abc")
      .send(VALID_REQUEST)
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: "content-generation-service",
        taskName: "single-generation",
      }),
      expect.objectContaining({
        orgId: "org-internal-123",
        userId: "user-internal-456",
        runId: "campaign-run-abc",
      })
    );
  });

  it("should link generationRunId to DB record", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send(VALID_REQUEST)
      .expect(200);

    const linkCall = mockDbSetCalls.find((data) => "generationRunId" in data);
    expect(linkCall).toBeDefined();
    expect(linkCall!.generationRunId).toBe("run-456");
  });

  it("should link generationRunId to DB record even when updateRun fails", async () => {
    mockCreateRun.mockResolvedValueOnce({ id: "run-456" });
    mockUpdateRun.mockRejectedValueOnce(new Error("runs-service unavailable"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send(VALID_REQUEST)
      .expect(200);

    // generationRunId must be set in the DB even though updateRun failed
    const linkCall = mockDbSetCalls.find((data) => "generationRunId" in data);
    expect(linkCall).toBeDefined();
    expect(linkCall!.generationRunId).toBe("run-456");

    errorSpy.mockRestore();
  });

  it("should log at error level when run tracking fails", async () => {
    mockCreateRun.mockRejectedValueOnce(new Error("runs-service unavailable"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send(VALID_REQUEST)
      .expect(200); // Email still generated despite run tracking failure

    const trackingErrorCall = errorSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("RUN TRACKING FAILED")
    );
    expect(trackingErrorCall).toBeDefined();

    errorSpy.mockRestore();
  });

  it("should mark generation run as completed", async () => {
    await request(app)
      .post("/generate")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send(VALID_REQUEST)
      .expect(200);

    expect(mockUpdateRun).toHaveBeenCalledWith(
      "run-456",
      "completed",
      expect.objectContaining({ runId: "run-456" })
    );
  });
});
