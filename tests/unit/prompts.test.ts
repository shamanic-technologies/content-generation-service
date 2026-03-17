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

// ---------------------------------------------------------------------------
// GET /prompts?type=
// ---------------------------------------------------------------------------
describe("GET /prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    const { default: promptRoutes } = await import("../../src/routes/prompts.js");
    app.use(promptRoutes);
  });

  it("returns prompt by type", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: null,
      type: "cold-email",
      prompt: "Write an email to {{recipient}}",
      variables: ["recipient"],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await request(app)
      .get("/prompts?type=cold-email")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .expect(200);

    expect(res.body.type).toBe("cold-email");
    expect(res.body.prompt).toBe("Write an email to {{recipient}}");
    expect(res.body.variables).toEqual(["recipient"]);
  });

  it("returns 404 when prompt not found", async () => {
    mockFindFirst.mockResolvedValue(null);

    await request(app)
      .get("/prompts?type=nonexistent")
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

// ---------------------------------------------------------------------------
// GET /platform-prompts?type=
// ---------------------------------------------------------------------------
describe("GET /platform-prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    const { default: promptRoutes } = await import("../../src/routes/prompts.js");
    app.use(promptRoutes);
  });

  it("returns prompt by type without identity headers", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: null,
      type: "cold-email",
      prompt: "Write an email to {{name}}",
      variables: ["name"],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await request(app)
      .get("/platform-prompts?type=cold-email")
      .expect(200);

    expect(res.body.type).toBe("cold-email");
    expect(res.body.prompt).toBe("Write an email to {{name}}");
  });

  it("returns 404 when not found", async () => {
    mockFindFirst.mockResolvedValue(null);

    await request(app)
      .get("/platform-prompts?type=nonexistent")
      .expect(404);
  });

  it("returns 400 when type missing", async () => {
    await request(app)
      .get("/platform-prompts")
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// POST /prompts — Idempotent create
// ---------------------------------------------------------------------------
describe("POST /prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    const { default: promptRoutes } = await import("../../src/routes/prompts.js");
    app.use(promptRoutes);
  });

  it("creates a new prompt and returns 201", async () => {
    mockFindFirst.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([{
      id: "prompt-1",
      orgId: "org-internal-123",
      type: "cold-email",
      prompt: "Write an email to {{recipient}}",
      variables: ["recipient"],
      createdAt: NOW,
      updatedAt: NOW,
    }]);

    const res = await request(app)
      .post("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "cold-email",
        prompt: "Write an email to {{recipient}}",
        variables: ["recipient"],
      })
      .expect(201);

    expect(res.body.id).toBe("prompt-1");
    expect(res.body.type).toBe("cold-email");
  });

  it("returns 200 (no-op) when type already exists", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-existing",
      orgId: null,
      type: "cold-email",
      prompt: "Existing prompt",
      variables: ["name"],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await request(app)
      .post("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        type: "cold-email",
        prompt: "Different prompt content",
        variables: ["name"],
      })
      .expect(200);

    expect(res.body.id).toBe("prompt-existing");
    expect(res.body.prompt).toBe("Existing prompt");
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it("returns 400 for missing required fields", async () => {
    await request(app)
      .post("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({})
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// POST /platform-prompts — Idempotent create (no headers)
// ---------------------------------------------------------------------------
describe("POST /platform-prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    const { default: promptRoutes } = await import("../../src/routes/prompts.js");
    app.use(promptRoutes);
  });

  it("creates a new prompt without identity headers", async () => {
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

    const res = await request(app)
      .post("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "Write an email to {{name}}",
        variables: ["name"],
      })
      .expect(201);

    expect(res.body.id).toBe("prompt-new");
    expect(res.body.type).toBe("cold-email");
  });

  it("returns 200 (no-op) when type already exists", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-existing",
      orgId: null,
      type: "cold-email",
      prompt: "Existing prompt",
      variables: ["name"],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await request(app)
      .post("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "New prompt",
        variables: ["name"],
      })
      .expect(200);

    expect(res.body.id).toBe("prompt-existing");
    expect(mockInsertReturning).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body", async () => {
    await request(app)
      .post("/platform-prompts")
      .send({ type: "cold-email" })
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// PUT /prompts — Create new versioned prompt
// ---------------------------------------------------------------------------
describe("PUT /prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    const { default: promptRoutes } = await import("../../src/routes/prompts.js");
    app.use(promptRoutes);
  });

  it("creates cold-email-v2 from cold-email", async () => {
    // Source exists
    mockFindFirst.mockResolvedValue({
      id: "prompt-source",
      orgId: null,
      type: "cold-email",
      prompt: "Old prompt",
      variables: ["name"],
      createdAt: NOW,
      updatedAt: NOW,
    });
    // No existing versions
    mockFindMany.mockResolvedValue([]);
    mockInsertReturning.mockResolvedValue([{
      id: "prompt-new",
      orgId: "org-internal-123",
      type: "cold-email-v2",
      prompt: "Improved prompt for {{name}} with {{brandProfile}}",
      variables: ["name", "brandProfile"],
      createdAt: NOW,
      updatedAt: NOW,
    }]);

    const res = await request(app)
      .put("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        sourceType: "cold-email",
        prompt: "Improved prompt for {{name}} with {{brandProfile}}",
        variables: ["name", "brandProfile"],
      })
      .expect(201);

    expect(res.body.type).toBe("cold-email-v2");
  });

  it("increments to v3 when v2 already exists", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-source",
      orgId: null,
      type: "cold-email",
      prompt: "Old prompt",
      variables: ["name"],
      createdAt: NOW,
      updatedAt: NOW,
    });
    // v2 already exists
    mockFindMany.mockResolvedValue([{ type: "cold-email-v2" }]);
    mockInsertReturning.mockResolvedValue([{
      id: "prompt-new",
      orgId: "org-internal-123",
      type: "cold-email-v3",
      prompt: "Even better prompt",
      variables: ["name"],
      createdAt: NOW,
      updatedAt: NOW,
    }]);

    const res = await request(app)
      .put("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        sourceType: "cold-email",
        prompt: "Even better prompt",
        variables: ["name"],
      })
      .expect(201);

    expect(res.body.type).toBe("cold-email-v3");
  });

  it("creates v6 from cold-email-v5", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-v5",
      orgId: null,
      type: "cold-email-v5",
      prompt: "V5 prompt",
      variables: ["name"],
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Existing versions: v2, v3, v4, v5
    mockFindMany.mockResolvedValue([
      { type: "cold-email-v2" },
      { type: "cold-email-v3" },
      { type: "cold-email-v4" },
      { type: "cold-email-v5" },
    ]);
    mockInsertReturning.mockResolvedValue([{
      id: "prompt-new",
      orgId: "org-internal-123",
      type: "cold-email-v6",
      prompt: "V6 prompt",
      variables: ["name"],
      createdAt: NOW,
      updatedAt: NOW,
    }]);

    const res = await request(app)
      .put("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        sourceType: "cold-email-v5",
        prompt: "V6 prompt",
        variables: ["name"],
      })
      .expect(201);

    expect(res.body.type).toBe("cold-email-v6");
  });

  it("creates prompt directly when sourceType does not exist", async () => {
    mockFindFirst.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([{
      id: "prompt-new",
      orgId: "org-internal-123",
      type: "brand-intro",
      prompt: "Introduce {{brandName}}",
      variables: ["brandName"],
      createdAt: NOW,
      updatedAt: NOW,
    }]);

    const res = await request(app)
      .put("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({
        sourceType: "brand-intro",
        prompt: "Introduce {{brandName}}",
        variables: ["brandName"],
      })
      .expect(201);

    expect(res.body.type).toBe("brand-intro");
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("returns 400 for missing required fields", async () => {
    await request(app)
      .put("/prompts")
      .set("X-Org-Id", "org-internal-123")
      .set("X-User-Id", "user-internal-456")
      .send({})
      .expect(400);
  });
});
