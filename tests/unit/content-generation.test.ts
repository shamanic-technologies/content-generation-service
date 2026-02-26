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
const mockGetByokKey = vi.fn().mockResolvedValue("fake-byok-key");
const mockGetAppKey = vi.fn().mockResolvedValue("fake-app-key");

vi.mock("../../src/lib/key-client.js", () => ({
  getByokKey: (...args: unknown[]) => mockGetByokKey(...args),
  getAppKey: (...args: unknown[]) => mockGetAppKey(...args),
}));

// Mock content-client
const MOCK_TOKENS_INPUT = 1200;
const MOCK_TOKENS_OUTPUT = 350;

const mockGenerateContent = vi.fn().mockResolvedValue({
  subject: "Test Subject",
  bodyHtml: "<p>Test body</p>",
  bodyText: "Test body",
  tokensInput: MOCK_TOKENS_INPUT,
  tokensOutput: MOCK_TOKENS_OUTPUT,
  promptRaw: "test prompt",
  responseRaw: {},
});

const mockGenerateCalendar = vi.fn().mockResolvedValue({
  title: "Test Event",
  description: "A test event description",
  location: "Online",
  tokensInput: 800,
  tokensOutput: 200,
  promptRaw: "test prompt",
  responseRaw: {},
});

vi.mock("../../src/lib/content-client.js", () => ({
  generateContent: (...args: unknown[]) => mockGenerateContent(...args),
  generateCalendar: (...args: unknown[]) => mockGenerateCalendar(...args),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("POST /generate/content", () => {
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

  it("should return generated email content", async () => {
    const res = await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send({
        appId: "my-app",
        prompt: "Write a welcome email for a webinar about sales techniques",
        keyMode: "byok",
      })
      .expect(200);

    expect(res.body.id).toBe("gen-789");
    expect(res.body.subject).toBe("Test Subject");
    expect(res.body.bodyHtml).toBe("<p>Test body</p>");
    expect(res.body.bodyText).toBe("Test body");
    expect(res.body.tokensInput).toBe(MOCK_TOKENS_INPUT);
    expect(res.body.tokensOutput).toBe(MOCK_TOKENS_OUTPUT);
  });

  it("should pass variables to generateContent", async () => {
    await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send({
        appId: "my-app",
        prompt: "Write a webinar reminder",
        variables: ["firstName", "webinarStartTime"],
        keyMode: "byok",
      })
      .expect(200);

    expect(mockGenerateContent).toHaveBeenCalledWith(
      "fake-byok-key",
      expect.objectContaining({
        variables: ["firstName", "webinarStartTime"],
      })
    );
  });

  it("should pass includeFooter to generateContent", async () => {
    await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send({
        appId: "my-app",
        prompt: "Write a webinar reminder",
        includeFooter: true,
        keyMode: "byok",
      })
      .expect(200);

    expect(mockGenerateContent).toHaveBeenCalledWith(
      "fake-byok-key",
      expect.objectContaining({
        includeFooter: true,
      })
    );
  });

  it("should use getByokKey when keyMode is byok", async () => {
    await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send({
        appId: "my-app",
        prompt: "Write an email",
        keyMode: "byok",
      })
      .expect(200);

    expect(mockGetByokKey).toHaveBeenCalledWith("org_test", "anthropic", { callerMethod: "POST", callerPath: "/generate/content" });
    expect(mockGetAppKey).not.toHaveBeenCalled();
  });

  it("should use getAppKey when keyMode is app", async () => {
    await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send({
        appId: "my-app",
        prompt: "Write an email",
        keyMode: "app",
      })
      .expect(200);

    expect(mockGetAppKey).toHaveBeenCalledWith("my-app", "anthropic", { callerMethod: "POST", callerPath: "/generate/content" });
    expect(mockGetByokKey).not.toHaveBeenCalled();
  });

  it("should return 400 for missing prompt", async () => {
    const res = await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send({
        appId: "my-app",
        keyMode: "byok",
      })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("should return 400 for invalid keyMode", async () => {
    const res = await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send({
        appId: "my-app",
        prompt: "Write an email",
        keyMode: "invalid",
      })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("should pass parentRunId to createRun when provided", async () => {
    await request(app)
      .post("/generate/content")
      .set("X-Org-Id", "org_test")
      .send({
        appId: "my-app",
        prompt: "Write an email",
        keyMode: "byok",
        parentRunId: "parent-run-abc",
      })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: "parent-run-abc",
        serviceName: "content-generation-service",
        taskName: "content-generation",
      })
    );
  });
});
