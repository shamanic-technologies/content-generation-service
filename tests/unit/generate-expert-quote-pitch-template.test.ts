import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateExpertQuotePitchFromTemplate, ExpertQuotePitchLengthError, InsufficientCreditsError } from "../../src/lib/anthropic-client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const TEMPLATE = "Pitch for {{brandName}} answering: {{requestQuestion}}";
const VARIABLES = { brandName: "Acme", requestQuestion: "How do you ship faster?" };
const MIN = 100;
const MAX = 2500;

function textResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        content,
        tokensInput: 100,
        tokensOutput: 50,
        model: "claude-sonnet-4-6",
      }),
  };
}

function pitchOf(len: number, prefix = "x"): string {
  return prefix + "y".repeat(Math.max(0, len - prefix.length));
}

describe("generateExpertQuotePitchFromTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls chat-service with responseFormat 'text' and substituted prompt", async () => {
    mockFetch.mockResolvedValueOnce(textResponse(pitchOf(500)));

    const result = await generateExpertQuotePitchFromTemplate(
      { promptTemplate: TEMPLATE, variables: VARIABLES, minChars: MIN, maxChars: MAX },
      IDENTITY
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/complete");
    const body = JSON.parse(opts.body);
    expect(body.responseFormat).toBe("text");
    expect(body.message).toContain("Acme");
    expect(body.message).toContain("How do you ship faster?");
    expect(body.systemPrompt).toContain("between 100 and 2500 characters");
    expect(result.attempts).toBe(1);
    expect(result.charCount).toBe(500);
  });

  it("returns the pitch on first attempt when length is in range", async () => {
    const pitch = pitchOf(800, "Hello, ");
    mockFetch.mockResolvedValueOnce(textResponse(pitch));

    const result = await generateExpertQuotePitchFromTemplate(
      { promptTemplate: TEMPLATE, variables: VARIABLES, minChars: MIN, maxChars: MAX },
      IDENTITY
    );

    expect(result.pitch).toBe(pitch);
    expect(result.charCount).toBe(800);
    expect(result.attempts).toBe(1);
    expect(result.tokensInput).toBe(100);
    expect(result.tokensOutput).toBe(50);
  });

  it("retries once when first attempt is too short", async () => {
    mockFetch
      .mockResolvedValueOnce(textResponse(pitchOf(50))) // too short
      .mockResolvedValueOnce(textResponse(pitchOf(500))); // valid

    const result = await generateExpertQuotePitchFromTemplate(
      { promptTemplate: TEMPLATE, variables: VARIABLES, minChars: MIN, maxChars: MAX },
      IDENTITY
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.charCount).toBe(500);
    expect(result.tokensInput).toBe(200);

    const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(retryBody.systemPrompt).toContain("TOO SHORT");
  });

  it("retries once when first attempt is too long", async () => {
    mockFetch
      .mockResolvedValueOnce(textResponse(pitchOf(MAX + 200))) // too long
      .mockResolvedValueOnce(textResponse(pitchOf(800))); // valid

    const result = await generateExpertQuotePitchFromTemplate(
      { promptTemplate: TEMPLATE, variables: VARIABLES, minChars: MIN, maxChars: MAX },
      IDENTITY
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.charCount).toBe(800);

    const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(retryBody.systemPrompt).toContain("TOO LONG");
  });

  it("throws ExpertQuotePitchLengthError when both attempts are too short", async () => {
    mockFetch
      .mockResolvedValueOnce(textResponse(pitchOf(40)))
      .mockResolvedValueOnce(textResponse(pitchOf(60)));

    await expect(
      generateExpertQuotePitchFromTemplate(
        { promptTemplate: TEMPLATE, variables: VARIABLES, minChars: MIN, maxChars: MAX },
        IDENTITY
      )
    ).rejects.toBeInstanceOf(ExpertQuotePitchLengthError);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws ExpertQuotePitchLengthError when both attempts are too long", async () => {
    mockFetch
      .mockResolvedValueOnce(textResponse(pitchOf(MAX + 100)))
      .mockResolvedValueOnce(textResponse(pitchOf(MAX + 50)));

    try {
      await generateExpertQuotePitchFromTemplate(
        { promptTemplate: TEMPLATE, variables: VARIABLES, minChars: MIN, maxChars: MAX },
        IDENTITY
      );
      expect.fail("expected ExpertQuotePitchLengthError");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpertQuotePitchLengthError);
      const e = err as ExpertQuotePitchLengthError;
      expect(e.charCount).toBe(MAX + 50);
      expect(e.minChars).toBe(MIN);
      expect(e.maxChars).toBe(MAX);
      expect(e.attempts).toBe(2);
    }
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("strips surrounding markdown fences and quotes from pitch", async () => {
    const innerPitch = pitchOf(500, "Real pitch starts here");
    mockFetch.mockResolvedValueOnce(textResponse('```text\n"' + innerPitch + '"\n```'));

    const result = await generateExpertQuotePitchFromTemplate(
      { promptTemplate: TEMPLATE, variables: VARIABLES, minChars: MIN, maxChars: MAX },
      IDENTITY
    );

    expect(result.pitch).toBe(innerPitch);
    expect(result.pitch.startsWith("`")).toBe(false);
    expect(result.pitch.startsWith('"')).toBe(false);
  });

  it("propagates InsufficientCreditsError on 402", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ balance_cents: 1, required_cents: 5 }),
    });

    await expect(
      generateExpertQuotePitchFromTemplate(
        { promptTemplate: TEMPLATE, variables: VARIABLES, minChars: MIN, maxChars: MAX },
        IDENTITY
      )
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it("forwards identity headers to chat-service", async () => {
    mockFetch.mockResolvedValueOnce(textResponse(pitchOf(500)));

    await generateExpertQuotePitchFromTemplate(
      { promptTemplate: TEMPLATE, variables: VARIABLES, minChars: MIN, maxChars: MAX },
      { orgId: "org-1", userId: "user-1", runId: "run-1", campaignId: "camp-9", brandId: "brand-9", workflowSlug: "wf", featureSlug: "feat" }
    );

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-campaign-id"]).toBe("camp-9");
    expect(headers["x-brand-id"]).toBe("brand-9");
    expect(headers["x-workflow-slug"]).toBe("wf");
    expect(headers["x-feature-slug"]).toBe("feat");
  });
});
