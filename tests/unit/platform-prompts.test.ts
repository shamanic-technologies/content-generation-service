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

// Track DB operations
const mockFindFirst = vi.fn();
const mockInsertValues: Array<Record<string, unknown>> = [];
const mockUpdateSetCalls: Array<Record<string, unknown>> = [];

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        mockInsertValues.push(data);
        return {
          returning: vi.fn().mockResolvedValue([{
            id: "prompt-new",
            orgId: data.orgId ?? null,
            type: data.type,
            variables: data.variables,
            createdAt: new Date("2026-03-12"),
            updatedAt: new Date("2026-03-12"),
          }]),
        };
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        mockUpdateSetCalls.push(data);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: "prompt-existing",
              orgId: null,
              type: "cold-email",
              variables: data.variables ?? ["leadFirstName"],
              createdAt: new Date("2026-03-10"),
              updatedAt: new Date("2026-03-12"),
            }]),
          }),
        };
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

describe("PUT /platform-prompts", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInsertValues.length = 0;
    mockUpdateSetCalls.length = 0;

    app = createTestApp();
    const { default: promptRoutes } = await import("../../src/routes/prompts.js");
    app.use(promptRoutes);
  });

  it("creates a new platform prompt (orgId = null)", async () => {
    mockFindFirst.mockResolvedValueOnce(null); // no existing

    const res = await request(app)
      .put("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "Write a cold email to {{leadFirstName}}",
        variables: ["leadFirstName"],
      })
      .expect(200);

    expect(res.body.id).toBe("prompt-new");
    expect(res.body.type).toBe("cold-email");
    expect(res.body).not.toHaveProperty("orgId");

    // Verify orgId is null in the insert
    expect(mockInsertValues[0]).toEqual(
      expect.objectContaining({
        orgId: null,
        type: "cold-email",
      })
    );
  });

  it("updates an existing platform prompt (idempotent)", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: "prompt-existing",
      orgId: null,
      type: "cold-email",
      prompt: "Old prompt",
      variables: ["old"],
    });

    const res = await request(app)
      .put("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "Updated prompt for {{leadFirstName}}",
        variables: ["leadFirstName"],
      })
      .expect(200);

    expect(res.body.id).toBe("prompt-existing");
    expect(mockUpdateSetCalls[0]).toEqual(
      expect.objectContaining({
        prompt: "Updated prompt for {{leadFirstName}}",
        variables: ["leadFirstName"],
      })
    );
  });

  it("does not require x-org-id, x-user-id, x-run-id headers", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    // Send without any identity headers — should still work
    await request(app)
      .put("/platform-prompts")
      .send({
        type: "cold-email",
        prompt: "Write an email to {{name}}",
        variables: ["name"],
      })
      .expect(200);
  });

  it("returns 400 for invalid request body", async () => {
    await request(app)
      .put("/platform-prompts")
      .send({ type: "cold-email" }) // missing prompt and variables
      .expect(400);
  });
});
