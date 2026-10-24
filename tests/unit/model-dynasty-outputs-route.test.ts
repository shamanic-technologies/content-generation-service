import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const readModelDynastyOutputs = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/model-dynasty-outputs.js", () => ({ readModelDynastyOutputs }));

const { default: routes } = await import("../../src/routes/model-dynasty-outputs.js");
const { ModelDynastyNotFoundError, ModelDynastyCatalogueError } = await import("../../src/lib/model-dynasty-client.js");

function app() {
  const a = express();
  a.use(routes);
  return a;
}

const PIPE = "featureSlug=sales-cold-email-outreach&legKey=lead_found_to_conversation";

describe("GET /internal/model-dynasties/:slug/outputs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serves the outputs of the pipe, default limit 5", async () => {
    const out = [{ generationId: "g", channel: "email", workflowSlug: "w", promptType: "t", templateDynasty: { slug: "d", name: "D", position: 1 }, model: "gemini-3.1-pro-preview", tokensInput: 1, tokensOutput: 2, subject: "s", emails: [], createdAt: "t" }];
    readModelDynastyOutputs.mockResolvedValue({ name: "Gemini Pro", modelIds: ["gemini-3.1-pro-preview"], outputs: out });
    const res = await request(app()).get(`/internal/model-dynasties/gemini-pro/outputs?${PIPE}`).expect(200);
    expect(res.body).toEqual({
      slug: "gemini-pro", name: "Gemini Pro", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation",
      modelIds: ["gemini-3.1-pro-preview"], outputs: out,
    });
    expect(readModelDynastyOutputs).toHaveBeenCalledWith({ slug: "gemini-pro", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", limit: 5 });
  });

  it("400s a missing pipe or a bad limit", async () => {
    await request(app()).get("/internal/model-dynasties/gemini-pro/outputs").expect(400);
    await request(app()).get("/internal/model-dynasties/gemini-pro/outputs?featureSlug=x").expect(400);
    await request(app()).get(`/internal/model-dynasties/gemini-pro/outputs?${PIPE}&limit=0`).expect(400);
    await request(app()).get(`/internal/model-dynasties/gemini-pro/outputs?${PIPE}&limit=21`).expect(400);
    expect(readModelDynastyOutputs).not.toHaveBeenCalled();
  });

  it("404s an unknown dynasty, 502s when chat-service cannot answer", async () => {
    readModelDynastyOutputs.mockRejectedValueOnce(new ModelDynastyNotFoundError("nope"));
    const r404 = await request(app()).get(`/internal/model-dynasties/nope/outputs?${PIPE}`).expect(404);
    expect(r404.body.code).toBe("MODEL_DYNASTY_NOT_FOUND");
    readModelDynastyOutputs.mockRejectedValueOnce(new ModelDynastyCatalogueError("chat down"));
    const r502 = await request(app()).get(`/internal/model-dynasties/gemini-pro/outputs?${PIPE}`).expect(502);
    expect(r502.body.code).toBe("MODEL_CATALOGUE_UNAVAILABLE");
  });
});
