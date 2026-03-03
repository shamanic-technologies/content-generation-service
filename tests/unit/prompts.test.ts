import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock auth middleware
vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-internal-123";
    req.userId = req.headers["x-user-id"] || "user-internal-456";
    req.runId = req.headers["x-run-id"] || "run-caller-123";
    next();
  },
}));

const NOW = new Date("2025-01-15T00:00:00Z");

// Mock the DB
const mockFindFirst = vi.fn();
const mockInsertReturning = vi.fn();
const mockUpdateReturning = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: (...args: unknown[]) => mockUpdateReturning(...args),
        }),
      }),
    }),
    query: {
      prompts: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
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

describe("PUT /prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    const { default: promptRoutes } = await import("../../src/routes/prompts.js");
    app.use(promptRoutes);
  });

  it("creates a new prompt when none exists", async () => {
    mockFindFirst.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([{
      id: "prompt-1",
      orgId: "org-internal-123",
      type: "email",
      prompt: "Write an email to {{recipient}}",
      variables: ["recipient"],
      createdAt: NOW,
      updatedAt: NOW,
    }]);

    const res = await request(app)
      .put("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        prompt: "Write an email to {{recipient}}",
        variables: ["recipient"],
      })
      .expect(200);

    expect(res.body.id).toBe("prompt-1");
    expect(res.body.orgId).toBe("org-internal-123");
    expect(res.body.type).toBe("email");
    expect(res.body.variables).toEqual(["recipient"]);
  });

  it("updates an existing prompt", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: "org-internal-123",
      type: "email",
      prompt: "old prompt",
      variables: ["old"],
    });
    mockUpdateReturning.mockResolvedValue([{
      id: "prompt-1",
      orgId: "org-internal-123",
      type: "email",
      prompt: "new prompt with {{newVar}}",
      variables: ["newVar"],
      createdAt: NOW,
      updatedAt: new Date("2025-01-16T00:00:00Z"),
    }]);

    const res = await request(app)
      .put("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "email",
        prompt: "new prompt with {{newVar}}",
        variables: ["newVar"],
      })
      .expect(200);

    expect(res.body.variables).toEqual(["newVar"]);
  });

  it("returns 400 for missing required fields", async () => {
    await request(app)
      .put("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({}) // missing type, prompt, variables
      .expect(400);
  });
});

describe("GET /prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    const { default: promptRoutes } = await import("../../src/routes/prompts.js");
    app.use(promptRoutes);
  });

  it("returns stored prompt", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: "org-internal-123",
      type: "email",
      prompt: "Write an email to {{recipient}}",
      variables: ["recipient"],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await request(app)
      .get("/prompts?type=email")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .expect(200);

    expect(res.body.prompt).toBe("Write an email to {{recipient}}");
    expect(res.body.variables).toEqual(["recipient"]);
  });

  it("returns 404 when prompt not found", async () => {
    mockFindFirst.mockResolvedValue(null);

    await request(app)
      .get("/prompts?type=email")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .expect(404);
  });

  it("returns 400 when type missing", async () => {
    await request(app)
      .get("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .expect(400);
  });
});
