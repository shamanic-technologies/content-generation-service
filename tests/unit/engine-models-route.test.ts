import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// RESEARCH-BY-ENGINE-1113-CG: writer models read and set per Engine, outputs per Engine.
const q = vi.hoisted(() => ({ listModelStatuses: vi.fn(), setModelStatus: vi.fn() }));
vi.mock("../../src/lib/catalogue-status-query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/catalogue-status-query.js")>();
  return { ...actual, ...q };
});
const readEngineModelOutputs = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/engine-model-outputs.js", () => ({ readEngineModelOutputs }));
const assertEngine = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/engine-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/engine-catalogue.js")>();
  return { ...actual, assertEngine };
});

const { default: routes } = await import("../../src/routes/engine-models.js");
const { EngineCatalogueError } = await import("../../src/lib/engine-catalogue.js");
const { ModelDynastyNotFoundError } = await import("../../src/lib/model-dynasty-client.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use(routes);
  return a;
}

const WHO = { "x-staff-email": "Kevin@Distribute.you" };
const ENTRY = {
  model: "claude-sonnet", provider: "anthropic", dynasty: "claude-sonnet", status: "deprecated", statusReason: "No sense for a click",
  statusChangedBy: "kevin@distribute.you", statusChangedAt: "2026-10-30T11:39:13.463Z", engine: "website_visit",
  engineStatuses: [{ engine: "website_visit", status: "deprecated" }],
};

describe("Engine model routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertEngine.mockImplementation(async (e: string) => {
      if (e === "nowhere") throw new EngineCatalogueError(404, "UNKNOWN_ENGINE", "No Engine");
      return e;
    });
  });

  it("GET models: every model's status on that Engine, no other grain served", async () => {
    q.listModelStatuses.mockResolvedValue([ENTRY]);
    const res = await request(app()).get("/internal/engines/website_visit/models").expect(200);
    expect(q.listModelStatuses).toHaveBeenCalledWith("website_visit");
    expect(res.body).toEqual({
      engine: "website_visit",
      models: [{ model: "claude-sonnet", provider: "anthropic", dynasty: "claude-sonnet", status: "deprecated", statusReason: "No sense for a click", statusChangedBy: "kevin@distribute.you", statusChangedAt: "2026-10-30T11:39:13.463Z" }],
    });
  });

  it("an unknown Engine is 404 UNKNOWN_ENGINE, nothing read or written", async () => {
    const r = await request(app()).get("/internal/engines/nowhere/models").expect(404);
    expect(r.body.code).toBe("UNKNOWN_ENGINE");
    await request(app()).put("/internal/engines/nowhere/models/claude-sonnet/status").set(WHO).send({ status: "deprecated", reason: "x" }).expect(404);
    await request(app()).get("/internal/engines/nowhere/model-dynasties/gpt-sol/outputs").expect(404);
    expect(q.listModelStatuses).not.toHaveBeenCalled();
    expect(q.setModelStatus).not.toHaveBeenCalled();
    expect(readEngineModelOutputs).not.toHaveBeenCalled();
  });

  it("PUT a status on one Engine: why + who required to deprecate, back to active without", async () => {
    q.setModelStatus.mockResolvedValue(ENTRY);
    const res = await request(app()).put("/internal/engines/website_visit/models/claude-sonnet/status").set(WHO)
      .send({ status: "deprecated", reason: "  No sense for a click  " }).expect(200);
    expect(q.setModelStatus).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet", provider: "anthropic" }), "website_visit", {
      status: "deprecated", reason: "No sense for a click", changedBy: "kevin@distribute.you",
    });
    expect(res.body).toMatchObject({ engine: "website_visit", model: "claude-sonnet", status: "deprecated", statusReason: "No sense for a click" });
    expect(res.body).not.toHaveProperty("engineStatuses");
    const noReason = await request(app()).put("/internal/engines/website_visit/models/claude-sonnet/status").set(WHO).send({ status: "deprecated" }).expect(400);
    expect(noReason.body.code).toBe("DEPRECATION_REASON_REQUIRED");
    const noWho = await request(app()).put("/internal/engines/website_visit/models/claude-sonnet/status").send({ status: "deprecated", reason: "x" }).expect(400);
    expect(noWho.body.code).toBe("DEPRECATED_BY_REQUIRED");
    await request(app()).put("/internal/engines/website_visit/models/gpt-9/status").set(WHO).send({ status: "deprecated", reason: "x" }).expect(404);
    expect(q.setModelStatus).toHaveBeenCalledTimes(1);
  });

  it("GET outputs: default limit 5, bad limit 400, unknown LLM 404", async () => {
    readEngineModelOutputs.mockResolvedValue({ name: "GPT Sol", modelIds: ["gpt-sol-2"], outputs: [] });
    const res = await request(app()).get("/internal/engines/email_sent/model-dynasties/gpt-sol/outputs").expect(200);
    expect(res.body).toEqual({ engine: "email_sent", slug: "gpt-sol", name: "GPT Sol", modelIds: ["gpt-sol-2"], outputs: [] });
    expect(readEngineModelOutputs).toHaveBeenCalledWith({ engine: "email_sent", slug: "gpt-sol", limit: 5 });
    await request(app()).get("/internal/engines/email_sent/model-dynasties/gpt-sol/outputs?limit=21").expect(400);
    readEngineModelOutputs.mockRejectedValueOnce(new ModelDynastyNotFoundError("nope"));
    const r404 = await request(app()).get("/internal/engines/email_sent/model-dynasties/nope/outputs").expect(404);
    expect(r404.body.code).toBe("MODEL_DYNASTY_NOT_FOUND");
  });
});
