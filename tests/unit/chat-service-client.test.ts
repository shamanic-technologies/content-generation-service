import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateFromTemplate, InsufficientCreditsError } from "../../src/lib/anthropic-client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const PARAMS = {
  promptTemplate: "Write an email to {{name}}",
  variables: { name: "Sarah" },
};

function successResponse(emails: Array<{ body: string; daysSinceLastStep: number }>) {
  const jsonPayload = { subject: "Test", emails };
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      content: JSON.stringify(jsonPayload),
      json: jsonPayload,
      tokensInput: 200,
      tokensOutput: 80,
      model: "claude-sonnet-4-6",
    }),
  };
}

describe("chat-service client (generateFromTemplate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls chat-service /complete with correct body", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate(PARAMS, IDENTITY);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/complete");

    const body = JSON.parse(opts.body);
    expect(body.message).toContain("Sarah");
    expect(body.systemPrompt).toBeDefined();
    expect(body.responseFormat).toBe("json");
    expect(body.maxTokens).toBe(3072);
  });

  it("passes identity headers to chat-service", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate(PARAMS, {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      campaignId: "camp-1",
      brandId: "brand-1",
      workflowSlug: "wf-1",
      featureSlug: "feat-1",
    });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(headers["x-campaign-id"]).toBe("camp-1");
    expect(headers["x-brand-id"]).toBe("brand-1");
    expect(headers["x-workflow-slug"]).toBe("wf-1");
    expect(headers["x-feature-slug"]).toBe("feat-1");
  });

  it("omits optional identity headers when not provided", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate(PARAMS, IDENTITY);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-campaign-id"]).toBeUndefined();
    expect(headers["x-brand-id"]).toBeUndefined();
  });

  it("throws InsufficientCreditsError on 402", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ error: "Insufficient credits", balance_cents: 2, required_cents: 5 }),
    });

    await expect(generateFromTemplate(PARAMS, IDENTITY)).rejects.toThrow(InsufficientCreditsError);

    try {
      await generateFromTemplate(PARAMS, IDENTITY);
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientCreditsError);
      const e = err as InsufficientCreditsError;
      expect(e.balance_cents).toBe(2);
      expect(e.required_cents).toBe(5);
    }
  });

  it("throws on non-OK, non-402 responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: () => Promise.resolve("Bad Gateway"),
    });

    await expect(generateFromTemplate(PARAMS, IDENTITY)).rejects.toThrow("chat-service /complete failed: 502");
  });

  it("returns token counts and model from chat-service", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.tokensInput).toBe(200);
    expect(result.tokensOutput).toBe(80);
    expect(result.model).toBe("claude-sonnet-4-6");
  });

  it("uses data.json (not data.content) — ignores markdown fences in content", async () => {
    const emails = [{ body: "Hello", daysSinceLastStep: 0 }];
    const jsonPayload = { subject: "Clean", emails };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        // content has markdown code fences (the bug scenario)
        content: '```json\n' + JSON.stringify(jsonPayload) + '\n```',
        // json is pre-parsed and clean
        json: jsonPayload,
        tokensInput: 100,
        tokensOutput: 50,
        model: "claude-sonnet-4-6",
      }),
    });

    // Should NOT throw — we read data.json, not data.content
    const result = await generateFromTemplate(PARAMS, IDENTITY);
    expect(result.subject).toBe("Clean");
    expect(result.sequence).toHaveLength(1);
    expect(result.sequence[0].bodyText).toBe("Hello");
  });

  it("includes JSON schema instructions in systemPrompt", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate(PARAMS, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.systemPrompt).toContain('"subject"');
    expect(body.systemPrompt).toContain('"emails"');
    expect(body.systemPrompt).toContain('"daysSinceLastStep"');
  });
});
