import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// GET /internal/generations/recorded: query validation and what reaches the query module.
// The query itself runs on real Postgres in tests/integration/recorded-generations-query.test.ts.

const mockRead = vi.fn();
vi.mock("../../src/lib/recorded-generations-query.js", () => ({
  readRecordedGenerations: (...a: unknown[]) => mockRead(...a),
}));
vi.mock("../../src/db/index.js", () => ({ db: {} }));
vi.mock("../../src/db/schema.js", () => ({ emailGenerations: {}, whatsappGenerations: {} }));

describe("GET /internal/generations/recorded", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRead.mockResolvedValue({ generations: [], nextCursor: null, hasMore: false });
    app = express();
    const { default: routes } = await import("../../src/routes/recorded-generations.js");
    app.use(routes);
  });

  it("reads a time window, 50 per page by default, held back 60 s", async () => {
    const res = await request(app)
      .get("/internal/generations/recorded")
      .query({ from: "2026-10-29T00:00:00Z", to: "2026-10-30T00:00:00Z" })
      .expect(200);
    expect(res.body).toEqual({ generations: [], nextCursor: null, hasMore: false });
    expect(mockRead).toHaveBeenCalledWith({
      from: "2026-10-29T00:00:00Z",
      to: "2026-10-30T00:00:00Z",
      runId: undefined,
      cursor: null,
      limit: 50,
      settleSeconds: 60,
    });
  });

  it("reads one run with no window", async () => {
    await request(app).get("/internal/generations/recorded").query({ runId: "run-9", limit: "5" }).expect(200);
    expect(mockRead.mock.calls[0][0]).toMatchObject({ runId: "run-9", from: undefined, limit: 5 });
  });

  it("decodes the cursor it issued", async () => {
    const { encodeCursor } = await import("../../src/lib/sequence-feed-query.js");
    const c = { createdAt: "2026-10-29 10:00:00.123456+00", id: "0b0f6f8e-6a43-4d55-9d4c-2f9c1e0d7a11" };
    await request(app).get("/internal/generations/recorded").query({ from: "2026-10-29T00:00:00Z", cursor: encodeCursor(c) }).expect(200);
    expect(mockRead.mock.calls[0][0].cursor).toEqual(c);
  });

  it.each([
    [{}, "from or runId is required"],
    [{ from: "yesterday" }, "from"],
    [{ from: "2026-10-29T00:00:00Z", limit: "101" }, "limit"],
    [{ from: "2026-10-29T00:00:00Z", cursor: "bm90LWEtY3Vyc29y" }, "cursor"],
  ])("refuses %j with 400", async (query, word) => {
    const res = await request(app).get("/internal/generations/recorded").query(query).expect(400);
    expect(res.body.error).toContain(word);
    expect(mockRead).not.toHaveBeenCalled();
  });
});
