import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { LEAD_CONTEXT_VARIABLES_PUBLISHED } from "../../src/lib/lead-context-variables";

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
      variables: [{ name: "leadFirstName", description: "Lead first name" }],
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

  it("publishes the lead + organization context variables every template accepts", async () => {
    mockFindFirst.mockResolvedValue({
      id: "prompt-1",
      orgId: null,
      type: "cold-email-v39",
      prompt: "Write a cold email to {{leadFirstName}}",
      variables: [{ name: "leadFirstName", description: "Lead first name" }],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await request(app)
      .get("/platform-prompts?type=cold-email-v39")
      .expect(200);

    // The template's own declared set is untouched: forks still match it exactly.
    expect(res.body.variables).toEqual([
      { name: "leadFirstName", description: "Lead first name" },
    ]);

    const contextNames = res.body.contextVariables.map((v: { name: string }) => v.name);
    expect(contextNames).toEqual(
      LEAD_CONTEXT_VARIABLES_PUBLISHED.map((v) => v.name)
    );
    for (const expected of [
      "leadSeniority",
      "leadEmploymentHistory",
      "leadCompanyFundingEvents",
      "leadCompanyCountry",
    ]) {
      expect(contextNames).toContain(expected);
    }
    for (const v of res.body.contextVariables) {
      expect(typeof v.description).toBe("string");
      expect(v.description.length).toBeGreaterThan(0);
    }
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
      variables: [{ name: "leadFirstName", description: "Lead first name" }],
      createdAt: NOW,
      updatedAt: NOW,
    }]);

    const res = await request(app)
      .post("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "Write a cold email to {{leadFirstName}}",
        variables: [{ name: "leadFirstName", description: "Lead first name" }],
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
      variables: [{ name: "leadFirstName", description: "Lead first name" }],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const res = await request(app)
      .post("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "Different prompt content",
        variables: [{ name: "leadFirstName", description: "Lead first name" }],
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
      variables: [{ name: "name", description: "Recipient name" }],
      createdAt: NOW,
      updatedAt: NOW,
    }]);

    await request(app)
      .post("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "Write an email to {{name}}",
        variables: [{ name: "name", description: "Recipient name" }],
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
