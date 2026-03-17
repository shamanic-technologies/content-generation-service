import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock auth middleware
vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-123";
    req.userId = req.headers["x-user-id"] || "user-456";
    req.runId = req.headers["x-run-id"] || "run-789";
    next();
  },
}));

const NOW = new Date("2026-03-12T00:00:00Z");

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockInsertReturning = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
      }),
    }),
    query: {
      prompts: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  prompts: { orgId: { name: "org_id" }, type: { name: "type" } },
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("GET /platform-prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    const { default: promptRoutes } = await import("../../src/routes/prompts.js");
    app.use(promptRoutes);
  });

  it("returns prompt without identity headers", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: null,
      type: "cold-email",
      prompt: "Write a cold email to {{leadFirstName}}",
      variables: ["leadFirstName"],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await request(app)
      .get("/platform-prompts?type=cold-email")
      .expect(200);

    expect(res.body.type).toBe("cold-email");
    expect(res.body.prompt).toContain("{{leadFirstName}}");
    expect(res.body).not.toHaveProperty("orgId");
  });
});

describe("POST /platform-prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    const { default: promptRoutes } = await import("../../src/routes/prompts.js");
    app.use(promptRoutes);
  });

  it("creates a new platform prompt (orgId = null) with 201", async () => {
    mockFindFirst.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([{
      id: "prompt-new",
      orgId: null,
      type: "cold-email",
      prompt: "Write a cold email to {{leadFirstName}}",
      variables: ["leadFirstName"],
      createdAt: NOW,
      updatedAt: NOW,
    }]);

    const res = await request(app)
      .post("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "Write a cold email to {{leadFirstName}}",
        variables: ["leadFirstName"],
      })
      .expect(201);

    expect(res.body.id).toBe("prompt-new");
    expect(res.body.type).toBe("cold-email");
    expect(res.body).not.toHaveProperty("orgId");
  });

  it("returns 200 (no-op) when type already exists", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-existing",
      orgId: null,
      type: "cold-email",
      prompt: "Existing prompt",
      variables: ["leadFirstName"],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await request(app)
      .post("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "Different prompt content",
        variables: ["leadFirstName"],
      })
      .expect(200);

    expect(res.body.id).toBe("prompt-existing");
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it("does not require x-org-id, x-user-id, x-run-id headers", async () => {
    mockFindFirst.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([{
      id: "prompt-new",
      orgId: null,
      type: "cold-email",
      prompt: "Write an email to {{name}}",
      variables: ["name"],
      createdAt: NOW,
      updatedAt: NOW,
    }]);

    await request(app)
      .post("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "Write an email to {{name}}",
        variables: ["name"],
      })
      .expect(201);
  });

  it("returns 400 for invalid request body", async () => {
    await request(app)
      .post("/platform-prompts")
      .send({ type: "cold-email" })
      .expect(400);
  });
});
