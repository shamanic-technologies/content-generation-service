import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const readWorkflowDynastyOutputs = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/workflow-dynasty-outputs.js", () => ({ readWorkflowDynastyOutputs }));

const { default: routes } = await import("../../src/routes/workflow-dynasty-outputs.js");

function app() {
  const a = express();
  a.use(routes);
  return a;
}

describe("GET /internal/workflow-dynasties/:slug/outputs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serves the outputs, default limit 20", async () => {
    const out = [{ generationId: "g", runId: "r", workflowSlug: "cold-v2", promptType: "cold-email-v9", templateDynasty: null, model: "m", subject: "s", emails: [], createdAt: "t" }];
    readWorkflowDynastyOutputs.mockResolvedValue(out);
    const res = await request(app()).get("/internal/workflow-dynasties/cold/outputs").expect(200);
    expect(res.body).toEqual({ slug: "cold", outputs: out });
    expect(readWorkflowDynastyOutputs).toHaveBeenCalledWith("cold", 20);
  });

  it("a dynasty never run is an empty list, not an error", async () => {
    readWorkflowDynastyOutputs.mockResolvedValue([]);
    const res = await request(app()).get("/internal/workflow-dynasties/never/outputs?limit=5").expect(200);
    expect(res.body).toEqual({ slug: "never", outputs: [] });
    expect(readWorkflowDynastyOutputs).toHaveBeenCalledWith("never", 5);
  });

  it("400s a bad limit, 502s when workflow-service cannot answer", async () => {
    await request(app()).get("/internal/workflow-dynasties/cold/outputs?limit=0").expect(400);
    await request(app()).get("/internal/workflow-dynasties/cold/outputs?limit=51").expect(400);
    readWorkflowDynastyOutputs.mockRejectedValue(new Error("workflow-service down: 503"));
    await request(app()).get("/internal/workflow-dynasties/cold/outputs").expect(502);
  });
});
