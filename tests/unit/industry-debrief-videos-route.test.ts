import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";

vi.mock("../../src/db/schema.js", () => ({ industryDebriefVideos: { id: {}, orgId: {}, idempotencyKey: {} } }));

const mockSelectRows = vi.fn();
const mockReturning = vi.fn();
const mockValues = vi.fn().mockReturnValue({ returning: (...a: unknown[]) => mockReturning(...a) });
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(mockSelectRows()) }) }),
    insert: () => ({ values: (...a: unknown[]) => mockValues(...a) }),
  },
}));

const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  updateRun: (...a: unknown[]) => mockUpdateRun(...a),
}));

const mockEnqueue = vi.fn();
vi.mock("../../src/lib/debrief/jobs.js", () => ({
  enqueueDebrief: (...a: unknown[]) => mockEnqueue(...a),
  toDebriefResponse: (r: { id: string; status: string; videoUrl?: string | null }) => ({ id: r.id, status: r.status, videoUrl: r.videoUrl ?? null }),
}));

import routes from "../../src/routes/industry-debrief-videos.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/industry-debrief-2026-10-12.json", import.meta.url), "utf8"));
const ID = "11111111-2222-3333-4444-555555555555";
const H = { "x-org-id": "6b9a0d9e-0000-4000-8000-000000000001", "x-user-id": "u1", "x-run-id": "parent-run", "x-campaign-id": "camp-1" };

function app() {
  const a = express();
  a.use(express.json());
  a.use(routes);
  return a;
}

describe("POST /industry-debrief-videos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateRun.mockResolvedValue({ id: "render-run" });
    mockReturning.mockResolvedValue([{ id: ID, status: "queued" }]);
  });

  it("400s an invalid body without opening a run", async () => {
    const res = await request(app()).post("/industry-debrief-videos").set(H).send({ ...fixture, stories: [] });
    expect(res.status).toBe(400);
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("queues the render in its own run and answers 202 at once", async () => {
    mockSelectRows.mockReturnValue([]);
    const res = await request(app()).post("/industry-debrief-videos").set(H).send(fixture);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: ID, status: "queued" });
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: "content-generation-service", taskName: "industry-debrief-video", campaignId: "camp-1" }),
      expect.objectContaining({ runId: "parent-run" }),
    );
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      parentRunId: "parent-run", runId: "render-run", idempotencyKey: "industry-debrief-2026-10-12",
      tracking: expect.objectContaining({ campaignId: "camp-1" }),
    }));
    expect(mockEnqueue).toHaveBeenCalledWith(ID);
  });

  it("answers the existing render for a repeated idempotencyKey (no second render)", async () => {
    mockSelectRows.mockReturnValue([{ id: ID, status: "rendering" }]);
    const res = await request(app()).post("/industry-debrief-videos").set(H).send(fixture);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("rendering");
    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("answers the concurrent winner when drizzle wraps the idempotency unique violation", async () => {
    const { DrizzleQueryError } = await import("drizzle-orm");
    mockSelectRows.mockReturnValueOnce([]).mockReturnValue([{ id: ID, status: "rendering" }]);
    mockUpdateRun.mockResolvedValue({});
    mockReturning.mockRejectedValue(new DrizzleQueryError("insert ...", [], Object.assign(new Error("dup"), {
      code: "23505", constraint_name: "idx_debrief_videos_idempotency",
    })));
    const res = await request(app()).post("/industry-debrief-videos").set(H).send(fixture);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("rendering");
    expect(mockUpdateRun).toHaveBeenCalledWith("render-run", "failed", expect.anything());
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("requires x-run-id", async () => {
    const { "x-run-id": _, ...noRun } = H;
    const res = await request(app()).post("/industry-debrief-videos").set(noRun).send(fixture);
    expect(res.status).toBe(400);
  });
});

describe("GET /industry-debrief-videos/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404s a render of another org / unknown id", async () => {
    mockSelectRows.mockReturnValue([]);
    const res = await request(app()).get(`/industry-debrief-videos/${ID}`).set(H);
    expect(res.status).toBe(404);
  });

  it("refuses a wait past the 300 s platform timeout budget", async () => {
    const res = await request(app()).get(`/industry-debrief-videos/${ID}?waitSeconds=500`).set(H);
    expect(res.status).toBe(400);
  });

  it("answers at once without waitSeconds", async () => {
    mockSelectRows.mockReturnValue([{ id: ID, status: "rendering" }]);
    const res = await request(app()).get(`/industry-debrief-videos/${ID}`).set(H);
    expect(res.body.status).toBe("rendering");
  });

  it("holds until the render finishes when asked to wait", async () => {
    mockSelectRows
      .mockReturnValueOnce([{ id: ID, status: "rendering" }])
      .mockReturnValue([{ id: ID, status: "done", videoUrl: "https://cdn/x.mp4" }]);
    const res = await request(app()).get(`/industry-debrief-videos/${ID}?waitSeconds=10`).set(H);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "done", videoUrl: "https://cdn/x.mp4" });
  });
});
