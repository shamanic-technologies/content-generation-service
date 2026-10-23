import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { WHATSAPP_TEMPLATE_V2, WHATSAPP_TEMPLATE_VARIABLES } from "../../src/lib/whatsapp-templates.js";

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "11111111-1111-4111-8111-111111111111";
    req.userId = "user-1";
    req.runId = "run-1";
    next();
  },
}));

const mockFindFirst = vi.fn();
const mockValues = vi.fn();
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: (...a: unknown[]) => mockValues(...a) }),
    query: { prompts: { findFirst: (...a: unknown[]) => mockFindFirst(...a) } },
  },
}));
vi.mock("../../src/db/schema.js", () => ({ prompts: { type: {} }, whatsappGenerations: {} }));

const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  updateRun: (...a: unknown[]) => mockUpdateRun(...a),
}));
import { declareStoredOutcomes } from "../../src/lib/outcome-declarations.js";

const vars = Object.fromEntries(WHATSAPP_TEMPLATE_VARIABLES.map((v) => [v.name, `<${v.name}>`]));
const body = (over: Record<string, unknown> = {}) => ({
  type: "whatsapp-signup-v2",
  variables: vars,
  context: "THE THREAD: (no message ever exchanged)",
  model: "claude-opus",
  campaignId: "camp-1",
  leadId: "lead-1",
  featureSlug: "cold-whatsapp-outreach",
  workflowSlug: "cold-whatsapp-outreach-zaurak-v18",
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
const completion = (json: Record<string, unknown>) =>
  new Response(JSON.stringify({ content: "", json, tokensInput: 10, tokensOutput: 5, model: "claude-opus-5-5" }), { status: 200 });

async function app() {
  const a = express();
  a.use(express.json());
  const { default: routes } = await import("../../src/routes/generate-whatsapp.js");
  a.use(routes);
  return a;
}

describe("POST /generate-whatsapp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFindFirst.mockResolvedValue({ type: "whatsapp-signup-v2", prompt: WHATSAPP_TEMPLATE_V2, variables: [] });
    mockValues.mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "gen-1" }]) });
    mockCreateRun.mockResolvedValue({ id: "wa-run-1" });
    mockUpdateRun.mockResolvedValue({});
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("writes with the template as the rules, our voice appended, the context as the message; answers the bubbles", async () => {
    fetchMock.mockResolvedValue(
      completion({ decision: "write", bubbles: ["hey Jeremy, Kevin from distribute.you", "honest read — you look like a fit", "who buys from you today?"], reason: "r", nextFollowUpAt: "2026-10-27T09:00:00Z", nextFollowUpWhy: "w" }),
    );
    const res = await request(await app()).post("/generate-whatsapp").send(body()).expect(200);
    expect(res.body).toMatchObject({
      id: "gen-1",
      decision: "write",
      bubbles: ["hey Jeremy, Kevin from distribute.you", "honest read, you look like a fit", "who buys from you today?"],
      message: "hey Jeremy, Kevin from distribute.you\n\nhonest read, you look like a fit\n\nwho buys from you today?",
      model: "claude-opus-5-5",
      promptType: "whatsapp-signup-v2",
      nextFollowUpAt: "2026-10-27T09:00:00Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/complete$/);
    const sent = JSON.parse(init.body);
    expect(sent.message).toBe("THE THREAD: (no message ever exchanged)");
    expect(sent.systemPrompt).toContain("<writerRole>");
    expect(sent.systemPrompt).toContain("2 to 5 bubbles");
    expect(sent.systemPrompt).toContain("TEST VOICE");
    expect(sent.systemPrompt).not.toMatch(/\{\{/);
    expect(sent.provider).toBe("anthropic");
    expect(sent.responseSchema.additionalProperties).toBe(false);
    expect(sent.responseSchema.required).toEqual(["decision", "bubbles", "reason", "nextFollowUpAt", "nextFollowUpWhy"]);
    // The completion runs under this service's own run (child of the caller's), so its cost
    // lands on the message_written this run declares (COST-ACCOUNTING-1023-P1).
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: "content-generation-service", taskName: "whatsapp-generation" }),
      expect.objectContaining({ runId: "run-1" }),
    );
    expect(init.headers["x-run-id"]).toBe("wa-run-1");
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      promptType: "whatsapp-signup-v2", decision: "write", leadId: "lead-1", campaignId: "camp-1",
      featureSlug: "cold-whatsapp-outreach", model: "claude-opus-5-5",
      generationRunId: "wa-run-1",
      outcomes: {
        produced: [{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: "lead-1" }],
        consumed: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-1" }],
      },
    }));
    expect(mockUpdateRun).toHaveBeenCalledWith("wa-run-1", "completed", expect.objectContaining({ runId: "wa-run-1" }));
    expect(declareStoredOutcomes).toHaveBeenCalledWith("whatsapp_generations", "gen-1");
  });

  it("runs-service down: the message is still written under the caller's run, nothing declared", async () => {
    mockCreateRun.mockRejectedValue(new Error("runs-service 503"));
    fetchMock.mockResolvedValue(completion({ decision: "write", bubbles: ["hi"], reason: "r", nextFollowUpAt: "2026-10-27T09:00:00Z", nextFollowUpWhy: "w" }));
    await request(await app()).post("/generate-whatsapp").send(body()).expect(200);
    expect(fetchMock.mock.calls[0][1].headers["x-run-id"]).toBe("run-1");
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ generationRunId: null, outcomes: null }));
    expect(declareStoredOutcomes).not.toHaveBeenCalled();
  });

  it("later: nothing to send, no bubbles", async () => {
    fetchMock.mockResolvedValue(completion({ decision: "later", bubbles: ["x"], reason: "night there", nextFollowUpAt: "2026-10-24T08:00:00Z", nextFollowUpWhy: "w" }));
    const res = await request(await app()).post("/generate-whatsapp").send(body()).expect(200);
    expect(res.body).toMatchObject({ decision: "later", bubbles: [], message: "" });
    // No message written = no outcome; the run's cost rolls into the nearest declaring ancestor.
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ generationRunId: "wa-run-1", outcomes: null }));
    expect(declareStoredOutcomes).not.toHaveBeenCalled();
  });

  it("400 VARIABLES_MISSING before any completion", async () => {
    const { voiceRules: _, ...rest } = vars;
    const res = await request(await app()).post("/generate-whatsapp").send(body({ variables: rest })).expect(400);
    expect(res.body).toMatchObject({ code: "VARIABLES_MISSING", missing: ["voiceRules"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400 UNKNOWN_MODEL, 404 TEMPLATE_NOT_FOUND", async () => {
    await request(await app()).post("/generate-whatsapp").send(body({ model: "nope" })).expect(400);
    mockFindFirst.mockResolvedValue(undefined);
    const res = await request(await app()).post("/generate-whatsapp").send(body()).expect(404);
    expect(res.body.code).toBe("TEMPLATE_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("402 passes through", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ balance_cents: 1, required_cents: 5 }), { status: 402 }));
    const res = await request(await app()).post("/generate-whatsapp").send(body()).expect(402);
    expect(res.body).toMatchObject({ balance_cents: 1, required_cents: 5 });
  });
});
