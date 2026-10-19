import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const q = vi.hoisted(() => ({
  listModelStatuses: vi.fn(),
  setModelStatus: vi.fn(),
  listTemplateStatuses: vi.fn(),
  setTemplateStatus: vi.fn(),
  templateExists: vi.fn(),
  readTemplateOutputs: vi.fn(),
}));

vi.mock("../../src/lib/catalogue-status-query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/catalogue-status-query.js")>();
  return { ...actual, ...q };
});

const { default: routes } = await import("../../src/routes/catalogue-status.js");
const { outputEmails } = await import("../../src/lib/catalogue-status-query.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use(routes);
  return a;
}

describe("staff catalogue status routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /internal/models lists every alias with its status", async () => {
    q.listModelStatuses.mockResolvedValue([{ model: "pro", provider: "google", status: "active", statusChangedAt: null }]);
    const res = await request(app()).get("/internal/models").expect(200);
    expect(res.body.models[0].status).toBe("active");
  });

  it("PUT a model status: deprecated and back", async () => {
    q.setModelStatus.mockImplementation(async (model, status) => ({ model, provider: "zai", status, statusChangedAt: "t" }));
    await request(app()).put("/internal/models/glm-pro/status").send({ status: "deprecated" }).expect(200);
    expect(q.setModelStatus).toHaveBeenLastCalledWith("glm-pro", "deprecated");
    await request(app()).put("/internal/models/glm-pro/status").send({ status: "active" }).expect(200);
    expect(q.setModelStatus).toHaveBeenLastCalledWith("glm-pro", "active");
  });

  it("404s an alias this service does not accept, 400s a bad status", async () => {
    await request(app()).put("/internal/models/gpt-9/status").send({ status: "deprecated" }).expect(404);
    await request(app()).put("/internal/models/pro/status").send({ status: "retired" }).expect(400);
    await request(app()).put("/internal/models/pro/status").send({}).expect(400);
    expect(q.setModelStatus).not.toHaveBeenCalled();
  });

  it("PUT a template status, 404 on an unknown type", async () => {
    q.setTemplateStatus.mockResolvedValueOnce({ type: "cold-email-v59", status: "deprecated", statusChangedAt: "t" });
    const ok = await request(app()).put("/internal/templates/cold-email-v59/status").send({ status: "deprecated" }).expect(200);
    expect(ok.body.status).toBe("deprecated");
    q.setTemplateStatus.mockResolvedValueOnce(null);
    await request(app()).put("/internal/templates/nope/status").send({ status: "active" }).expect(404);
  });

  it("GET outputs defaults to 5, caps at 20, 404s an unknown type", async () => {
    q.templateExists.mockResolvedValue(true);
    q.readTemplateOutputs.mockResolvedValue([]);
    const res = await request(app()).get("/internal/templates/cold-email-v59/outputs").expect(200);
    expect(res.body).toEqual({ type: "cold-email-v59", outputs: [] });
    expect(q.readTemplateOutputs).toHaveBeenCalledWith("cold-email-v59", 5);
    await request(app()).get("/internal/templates/cold-email-v59/outputs?limit=21").expect(400);
    q.templateExists.mockResolvedValue(false);
    await request(app()).get("/internal/templates/nope/outputs").expect(404);
  });

  it("a failing read answers 500, never hangs", async () => {
    q.listTemplateStatuses.mockRejectedValue(new Error("db down"));
    const res = await request(app()).get("/internal/templates").expect(500);
    expect(res.body.error).toBe("db down");
  });
});

describe("outputEmails", () => {
  it("one entry per stored step", () => {
    expect(
      outputEmails({ bodyText: null, bodyHtml: null, sequence: [{ step: 1, bodyText: "a", daysSinceLastStep: 0 }, { step: 2, bodyText: "b" }] })
    ).toEqual([
      { step: 1, bodyText: "a", daysSinceLastStep: 0 },
      { step: 2, bodyText: "b", daysSinceLastStep: null },
    ]);
  });
  it("a pre-sequence row is one email from its body column, no copy = none", () => {
    expect(outputEmails({ bodyText: "old", bodyHtml: null, sequence: null })).toEqual([{ step: 1, bodyText: "old", daysSinceLastStep: 0 }]);
    expect(outputEmails({ bodyText: null, bodyHtml: null, sequence: null })).toEqual([]);
  });
});
