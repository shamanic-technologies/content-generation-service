import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateFromTemplate, generateExpertQuotePitchFromTemplate, InsufficientCreditsError } from "../../src/lib/chat-service-client";

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
    expect(body.provider).toBe("google");
    expect(body.model).toBe("pro");
    // responseSchema enables Gemini structured-output mode (fixes Bad escaped character in JSON).
    // responseFormat + maxTokens are intentionally absent: responseSchema implies JSON mode,
    // and chat-service silently drops maxTokens.
    expect(body.responseFormat).toBeUndefined();
    expect(body.maxTokens).toBeUndefined();
    expect(body.responseSchema).toEqual({
      type: "object",
      properties: {
        subject: { type: "string" },
        emails: {
          type: "array",
          items: {
            type: "object",
            properties: {
              body: { type: "string" },
              daysSinceLastStep: { type: "number" },
            },
            required: ["body", "daysSinceLastStep"],
          },
        },
      },
      required: ["subject", "emails"],
    });
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

// ─── Model selection (provider derived from the alias) ───────────────────────
// The 8 chat-service aliases are unique across providers, so the caller picks ONE
// model and the provider is derived. Anthropic structured-output requires a STRICT
// response schema (additionalProperties:false); google ignores it, so the strict
// schema is sent ONLY for anthropic and the google path stays byte-identical.
// DeepSeek is called directly over its OpenAI-compatible API, which imposes no such
// requirement either, so it takes the permissive schema like google.
const STRICT_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string" },
    emails: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          body: { type: "string" },
          daysSinceLastStep: { type: "number" },
        },
        required: ["body", "daysSinceLastStep"],
      },
    },
  },
  required: ["subject", "emails"],
};

describe("model selection (generateFromTemplate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to google/pro with the permissive schema when model is omitted", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate(PARAMS, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("google");
    expect(body.model).toBe("pro");
    expect(body.responseSchema.additionalProperties).toBeUndefined();
  });

  it("model=sonnet derives the anthropic provider and sends the strict schema", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate({ ...PARAMS, model: "sonnet" }, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("sonnet");
    expect(body.responseSchema).toEqual(STRICT_RESPONSE_SCHEMA);
  });

  it("model=opus derives the anthropic provider", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate({ ...PARAMS, model: "opus" }, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("opus");
    expect(body.responseSchema.additionalProperties).toBe(false);
  });

  it("model=flash-pro derives the google provider and keeps the permissive schema", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate({ ...PARAMS, model: "flash-pro" }, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("google");
    expect(body.model).toBe("flash-pro");
    expect(body.responseSchema.additionalProperties).toBeUndefined();
  });

  it("model=deepseek-flash derives the deepseek provider and keeps the permissive schema", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate({ ...PARAMS, model: "deepseek-flash" }, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("deepseek");
    expect(body.model).toBe("deepseek-flash");
    expect(body.responseSchema.additionalProperties).toBeUndefined();
  });

  it("model=deepseek-pro derives the deepseek provider and keeps the permissive schema", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate({ ...PARAMS, model: "deepseek-pro" }, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("deepseek");
    expect(body.model).toBe("deepseek-pro");
    expect(body.responseSchema.additionalProperties).toBeUndefined();
  });

  it("never sends webSearch or imageUrl — the fields the deepseek path rejects", async () => {
    mockFetch.mockResolvedValueOnce(successResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate({ ...PARAMS, model: "deepseek-flash" }, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.webSearch).toBeUndefined();
    expect(body.imageUrl).toBeUndefined();
  });
});

describe("model selection (generateExpertQuotePitchFromTemplate, free-text)", () => {
  const PITCH_PARAMS = {
    promptTemplate: "Pitch for {{name}}",
    variables: { name: "Sarah" },
    minChars: 100,
    maxChars: 2500,
  };
  const PITCH_BODY = "x".repeat(150);

  function textResponse(content: string) {
    return {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ content, tokensInput: 100, tokensOutput: 50, model: "gemini-3-pro" }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to google/pro and never sends a responseSchema", async () => {
    mockFetch.mockResolvedValueOnce(textResponse(PITCH_BODY));

    await generateExpertQuotePitchFromTemplate(PITCH_PARAMS, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("google");
    expect(body.model).toBe("pro");
    expect(body.responseSchema).toBeUndefined();
  });

  it("model=haiku derives the anthropic provider (still no responseSchema)", async () => {
    mockFetch.mockResolvedValueOnce(textResponse(PITCH_BODY));

    await generateExpertQuotePitchFromTemplate({ ...PITCH_PARAMS, model: "haiku" }, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("haiku");
    expect(body.responseSchema).toBeUndefined();
  });

  it("model=deepseek-flash derives the deepseek provider (still no responseSchema)", async () => {
    mockFetch.mockResolvedValueOnce(textResponse(PITCH_BODY));

    await generateExpertQuotePitchFromTemplate(
      { ...PITCH_PARAMS, model: "deepseek-flash" },
      IDENTITY
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("deepseek");
    expect(body.model).toBe("deepseek-flash");
    expect(body.responseSchema).toBeUndefined();
  });

  it("model=deepseek-pro derives the deepseek provider (still no responseSchema)", async () => {
    mockFetch.mockResolvedValueOnce(textResponse(PITCH_BODY));

    await generateExpertQuotePitchFromTemplate({ ...PITCH_PARAMS, model: "deepseek-pro" }, IDENTITY);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider).toBe("deepseek");
    expect(body.model).toBe("deepseek-pro");
    expect(body.responseSchema).toBeUndefined();
  });
});
