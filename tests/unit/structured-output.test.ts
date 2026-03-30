import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateFromTemplate } from "../../src/lib/anthropic-client";

const CHAT_JSON = {
  subject: "Quick question",
  emails: [
    { body: "Hey Sarah,\n\nMost nonprofits treat community as a vanity metric — but the ones that last are built around shared purpose, not headcount.\n\nA client of mine is looking for a handful of organizers to help launch public goods initiatives. Would 30 minutes be worth a conversation?", daysSinceLastStep: 0 },
    { body: "Hey Sarah,\n\nJust circling back on my last note. Would love to connect for a quick chat.", daysSinceLastStep: 3 },
    { body: "Hey Sarah,\n\nDifferent angle — what if the biggest barrier to lasting community impact is actually thinking too small?", daysSinceLastStep: 7 },
  ],
};

const CHAT_RESPONSE = {
  content: JSON.stringify(CHAT_JSON),
  json: CHAT_JSON,
  tokensInput: 200,
  tokensOutput: 80,
  model: "claude-sonnet-4-6",
};

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: () => Promise.resolve(CHAT_RESPONSE),
});

vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };

describe("structured JSON output via chat-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(CHAT_RESPONSE),
    });
  });

  it("sends responseFormat 'json' to chat-service /complete", async () => {
    await generateFromTemplate(
      {
        promptTemplate: "Write an email to {{recipientName}}",
        variables: { recipientName: "Sarah" },
      },
      IDENTITY
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/complete");

    const body = JSON.parse(options.body);
    expect(body.responseFormat).toBe("json");
    expect(body.maxTokens).toBe(3072);
    expect(body.message).toContain("Sarah");
    expect(body.systemPrompt).toBeDefined();
  });

  it("parses JSON response into subject and 3-step sequence", async () => {
    const result = await generateFromTemplate(
      {
        promptTemplate: "Write an email to {{recipientName}}",
        variables: { recipientName: "Sarah" },
      },
      IDENTITY
    );

    expect(result.subject).toBe("Quick question");
    expect(result.sequence).toHaveLength(3);
    // Step 1
    expect(result.sequence[0].step).toBe(1);
    expect(result.sequence[0].bodyText).toContain("Hey Sarah");
    expect(result.sequence[0].bodyHtml).toContain("<p>");
    expect(result.sequence[0].daysSinceLastStep).toBe(0);
    // Step 2
    expect(result.sequence[1].step).toBe(2);
    expect(result.sequence[1].bodyText).toContain("circling back");
    expect(result.sequence[1].daysSinceLastStep).toBe(3);
    // Step 3
    expect(result.sequence[2].step).toBe(3);
    expect(result.sequence[2].bodyText).toContain("Different angle");
    expect(result.sequence[2].daysSinceLastStep).toBe(7);
  });

  it("sends a global system prompt with universal email rules and JSON schema", async () => {
    await generateFromTemplate(
      {
        promptTemplate: "Write an email to {{recipientName}}",
        variables: { recipientName: "Sarah" },
      },
      IDENTITY
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.systemPrompt).toContain("NEVER include a sign-off");
    expect(body.systemPrompt).toContain("NEVER use placeholders");
    expect(body.systemPrompt).toContain('"subject"');
    expect(body.systemPrompt).toContain('"emails"');
  });

  it("passes identity headers to chat-service", async () => {
    await generateFromTemplate(
      {
        promptTemplate: "Write an email to {{recipientName}}",
        variables: { recipientName: "Sarah" },
      },
      { orgId: "org-1", userId: "user-1", runId: "run-1", campaignId: "camp-1", brandId: "brand-1" }
    );

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(headers["x-campaign-id"]).toBe("camp-1");
    expect(headers["x-brand-id"]).toBe("brand-1");
  });

  it("returns token counts and model from chat-service response", async () => {
    const result = await generateFromTemplate(
      {
        promptTemplate: "Write an email to {{recipientName}}",
        variables: { recipientName: "Sarah" },
      },
      IDENTITY
    );

    expect(result.tokensInput).toBe(200);
    expect(result.tokensOutput).toBe(80);
    expect(result.model).toBe("claude-sonnet-4-6");
  });
});
