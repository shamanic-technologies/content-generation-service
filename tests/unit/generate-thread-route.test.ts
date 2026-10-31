import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "11111111-1111-4111-8111-111111111111";
    req.userId = "user-1";
    req.runId = "workflow-run-1";
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
vi.mock("../../src/db/schema.js", () => ({ prompts: { type: {} }, threadGenerations: {}, templateDynasties: {}, templateDynastyVersions: {} }));

const mockCreateRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({ createRun: (...a: unknown[]) => mockCreateRun(...a), updateRun: vi.fn() }));

const TEMPLATE = "You write ONE Threads thread for {{brandName}}.\nNever a call to action: the line \"{{getStartedLine}}\" is added after your last reply.";

const body = (over: Record<string, unknown> = {}) => ({
  type: "threads-data-finding-v1",
  variables: { brandName: "Acme", getStartedLine: "Get started: acme.com" },
  context: "BRAND: Acme (acme.com)\nOUR FACTS: (none)",
  model: "claude-opus",
  campaignId: "camp-1",
  featureSlug: "threads-post",
  workflowSlug: "threads-post-maasym-v3",
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
const completion = (json: Record<string, unknown>) =>
  new Response(JSON.stringify({ content: "", json, tokensInput: 10, tokensOutput: 5, model: "claude-opus-5-5" }), { status: 200 });

async function app() {
  const a = express();
  a.use(express.json());
  const { default: routes } = await import("../../src/routes/generate-thread.js");
  a.use(routes);
  return a;
}

describe("POST /generate-thread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFindFirst.mockResolvedValue({ type: "threads-data-finding-v1", prompt: TEMPLATE, variables: [] });
    mockValues.mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "thread-gen-1" }]) });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("writes with the template as the rules and the context as the message, under the CALLER's run; answers the thread as written", async () => {
    fetchMock.mockResolvedValue(
      completion({ subject: "reply rates", post: "Most founders write too long — short wins.", replies: ["Try 3 lines.", "", "What is your shortest email?"] }),
    );
    const res = await request(await app()).post("/generate-thread").send(body()).expect(200);
    expect(res.body).toEqual({
      id: "thread-gen-1",
      subject: "reply rates",
      post: "Most founders write too long, short wins.",
      replies: ["Try 3 lines.", "What is your shortest email?"],
      model: "claude-opus-5-5",
      promptType: "threads-data-finding-v1",
      tokensInput: 10,
      tokensOutput: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/complete$/);
    const sent = JSON.parse(init.body);
    expect(sent.message).toBe(body().context);
    expect(sent.systemPrompt).toContain("You write ONE Threads thread for Acme.");
    expect(sent.systemPrompt).toContain('"Get started: acme.com"');
    expect(sent.systemPrompt).not.toMatch(/\{\{/);
    // A public post is not a message to a client: our client-comms voice is not appended.
    expect(sent.systemPrompt).not.toContain("TEST VOICE");
    expect(sent.provider).toBe("anthropic");
    expect(sent.model).toBe("claude-opus");
    expect(sent.responseSchema.additionalProperties).toBe(false);
    expect(sent.responseSchema.required).toEqual(["subject", "post", "replies"]);
    // No run of our own, nothing declared: the cost rides the workflow run that publishes post_published.
    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(init.headers["x-run-id"]).toBe("workflow-run-1");
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      runId: "workflow-run-1",
      campaignId: "camp-1",
      featureSlug: "threads-post",
      workflowSlug: "threads-post-maasym-v3",
      promptType: "threads-data-finding-v1",
      model: "claude-opus-5-5",
      post: "Most founders write too long, short wins.",
      replies: ["Try 3 lines.", "What is your shortest email?"],
    }));
  });

  it("400 VARIABLES_MISSING before any completion", async () => {
    const res = await request(await app()).post("/generate-thread").send(body({ variables: { brandName: "Acme" } })).expect(400);
    expect(res.body).toMatchObject({ code: "VARIABLES_MISSING", missing: ["getStartedLine"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400 without a model: there is no default writer", async () => {
    const { model: _, ...rest } = body();
    await request(await app()).post("/generate-thread").send(rest).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 TEMPLATE_NOT_FOUND", async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const res = await request(await app()).post("/generate-thread").send(body()).expect(404);
    expect(res.body.code).toBe("TEMPLATE_NOT_FOUND");
  });

  it("502 when the model answers no main post, nothing stored", async () => {
    fetchMock.mockResolvedValue(completion({ subject: "x", post: "  ", replies: ["a"] }));
    await request(await app()).post("/generate-thread").send(body()).expect(502);
    expect(mockValues).not.toHaveBeenCalled();
  });
});
