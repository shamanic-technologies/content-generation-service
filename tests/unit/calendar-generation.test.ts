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
    req.clerkOrgId = req.headers["x-clerk-org-id"] || "org_test";
    next();
  },
}));

// Mock DB
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "gen-cal-789" }]),
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
vi.mock("../../src/lib/content-client.js", () => ({
  generateContent: vi.fn(),
  generateCalendar: vi.fn().mockResolvedValue({
    title: "Sexual Polarity in Relationships - Free Live Webinar",
    description: "90-minute live masterclass with Kevin & Maria exploring the dynamics of sexual polarity.",
    location: "Online (Zoom)",
    tokensInput: 800,
    tokensOutput: 200,
    promptRaw: "test prompt",
    responseRaw: {},
  }),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("POST /generate/calendar", () => {
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

  it("should return generated calendar event fields", async () => {
    const res = await request(app)
      .post("/generate/calendar")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "polaritycourse",
        prompt: "Generate calendar event for a webinar about sexual polarity with Kevin & Maria",
        keyMode: "app",
      })
      .expect(200);

    expect(res.body.id).toBe("gen-cal-789");
    expect(res.body.title).toContain("Sexual Polarity");
    expect(res.body.description).toContain("masterclass");
    expect(res.body.location).toBe("Online (Zoom)");
    expect(res.body.tokensInput).toBe(800);
    expect(res.body.tokensOutput).toBe(200);
  });

  it("should use getAppKey when keyMode is app", async () => {
    await request(app)
      .post("/generate/calendar")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "polaritycourse",
        prompt: "Generate calendar event",
        keyMode: "app",
      })
      .expect(200);

    expect(mockGetAppKey).toHaveBeenCalledWith("polaritycourse", "anthropic", { callerMethod: "POST", callerPath: "/generate/calendar" });
    expect(mockGetByokKey).not.toHaveBeenCalled();
  });

  it("should use getByokKey when keyMode is byok", async () => {
    await request(app)
      .post("/generate/calendar")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "polaritycourse",
        prompt: "Generate calendar event",
        keyMode: "byok",
      })
      .expect(200);

    expect(mockGetByokKey).toHaveBeenCalledWith("org_test", "anthropic", { callerMethod: "POST", callerPath: "/generate/calendar" });
    expect(mockGetAppKey).not.toHaveBeenCalled();
  });

  it("should return 400 for missing required fields", async () => {
    const res = await request(app)
      .post("/generate/calendar")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "polaritycourse",
        // missing prompt and keyMode
      })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it("should create run with calendar-generation task name", async () => {
    await request(app)
      .post("/generate/calendar")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        appId: "polaritycourse",
        prompt: "Generate calendar event",
        keyMode: "app",
        parentRunId: "parent-run-xyz",
      })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: "content-generation-service",
        taskName: "calendar-generation",
        parentRunId: "parent-run-xyz",
      })
    );
  });
});
