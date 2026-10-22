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
const { servedStatus, NOT_SPECIFIED } = await import("../../src/lib/catalogue-status.js");

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

  const WHO = { "x-staff-email": "Kevin@Distribute.you" };
  const served = (status: string, statusReason: string | null) => ({
    status, statusReason, statusChangedBy: "kevin@distribute.you", statusChangedAt: "t",
  });

  it("PUT a model status: deprecated with why + who, and back without a reason", async () => {
    q.setModelStatus.mockImplementation(async (entry, change) => ({ ...entry, ...served(change.status, change.reason) }));
    const dep = await request(app()).put("/internal/models/glm-pro/status").set(WHO)
      .send({ status: "deprecated", reason: "  Writes one block, no line breaks  " }).expect(200);
    expect(q.setModelStatus).toHaveBeenLastCalledWith(expect.objectContaining({ model: "glm-pro", provider: "zai" }), {
      status: "deprecated", reason: "Writes one block, no line breaks", changedBy: "kevin@distribute.you",
    });
    expect(dep.body.statusReason).toBe("Writes one block, no line breaks");
    await request(app()).put("/internal/models/glm-pro/status").send({ status: "active", reason: "x" }).expect(200);
    expect(q.setModelStatus).toHaveBeenLastCalledWith(expect.objectContaining({ model: "glm-pro", provider: "zai" }), { status: "active", reason: null, changedBy: null });
  });

  it("refuses a deprecation without a reason or without who, nothing written", async () => {
    for (const path of ["/internal/models/glm-pro/status", "/internal/templates/cold-email-v59/status"]) {
      const noReason = await request(app()).put(path).set(WHO).send({ status: "deprecated" }).expect(400);
      expect(noReason.body.code).toBe("DEPRECATION_REASON_REQUIRED");
      const blank = await request(app()).put(path).set(WHO).send({ status: "deprecated", reason: "   " }).expect(400);
      expect(blank.body.code).toBe("DEPRECATION_REASON_REQUIRED");
      const noWho = await request(app()).put(path).send({ status: "deprecated", reason: "old" }).expect(400);
      expect(noWho.body.code).toBe("DEPRECATED_BY_REQUIRED");
    }
    expect(q.setModelStatus).not.toHaveBeenCalled();
    expect(q.setTemplateStatus).not.toHaveBeenCalled();
  });

  it("PUT a dynasty slug's status: any name chat-service accepts, with its provider and dynasty", async () => {
    q.setModelStatus.mockImplementation(async (entry, change) => ({ ...entry, ...served(change.status, change.reason) }));
    const dep = await request(app()).put("/internal/models/claude-opus/status").set(WHO)
      .send({ status: "deprecated", reason: "Too slow" }).expect(200);
    expect(dep.body).toMatchObject({ model: "claude-opus", provider: "anthropic", dynasty: "claude-opus", status: "deprecated" });
  });

  it("404s an alias this service does not accept, 400s a bad status", async () => {
    await request(app()).put("/internal/models/gpt-9/status").set(WHO).send({ status: "deprecated", reason: "r" }).expect(404);
    await request(app()).put("/internal/models/pro/status").send({ status: "retired" }).expect(400);
    await request(app()).put("/internal/models/pro/status").send({}).expect(400);
    expect(q.setModelStatus).not.toHaveBeenCalled();
  });

  it("PUT a template status, 404 on an unknown type", async () => {
    q.setTemplateStatus.mockResolvedValueOnce({ type: "cold-email-v59", ...served("deprecated", "Replaced by v60") });
    const ok = await request(app()).put("/internal/templates/cold-email-v59/status").set(WHO)
      .send({ status: "deprecated", reason: "Replaced by v60" }).expect(200);
    expect(ok.body).toMatchObject({ status: "deprecated", statusReason: "Replaced by v60", statusChangedBy: "kevin@distribute.you" });
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

describe("servedStatus", () => {
  it("a row deprecated before reasons existed reads Not specified, no author invented", () => {
    const at = new Date("2026-10-19T16:53:17Z");
    expect(servedStatus({ status: "deprecated", statusReason: null, statusChangedBy: null, statusChangedAt: at })).toEqual({
      status: "deprecated", statusReason: NOT_SPECIFIED, statusChangedBy: null, statusChangedAt: at.toISOString(),
    });
    expect(NOT_SPECIFIED).toBe("Not specified");
  });
  it("an active row serves no reason", () => {
    expect(servedStatus({ status: "active", statusReason: null, statusChangedBy: null, statusChangedAt: null }).statusReason).toBeNull();
  });
});
