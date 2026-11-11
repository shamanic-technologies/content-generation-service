import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateFromTemplate,
  InsufficientCreditsError,
  MAX_GENERATION_ATTEMPTS,
} from "../../src/lib/chat-service-client";
import { IncompleteSequenceError } from "../../src/lib/sequence-delays";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const PARAMS = { promptTemplate: "Write an email", variables: {}, model: "deepseek-pro" as const };

function answer(emails: unknown[], tokens = { in: 100, out: 40 }) {
  const json = { subject: "S", emails };
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({ content: JSON.stringify(json), json, tokensInput: tokens.in, tokensOutput: tokens.out, model: "deepseek-v4-pro" }),
  };
}

// chat-service's exact answer when the model's text did not parse (src/index.ts, ModelJsonOutputError).
function invalidJson() {
  const body = { error: "LLM returned invalid JSON.", detail: "Unexpected token at position 646" };
  return { ok: false, status: 502, text: () => Promise.resolve(JSON.stringify(body)) };
}

const VALID = [
  { body: "a", daysSinceLastStep: 0 },
  { body: "b", daysSinceLastStep: 3 },
];
// Only step 1 is ever served (FOLLOWUP-JIT-1107), so only ITS delay can make an answer unusable.
const BAD_FIRST_DELAY = [{ body: "a", daysSinceLastStep: -1 }];
const MISSING_FOLLOW_UP_DELAYS = [{ body: "a", daysSinceLastStep: 0 }, { body: "b" }, { body: "c" }];

describe("generateFromTemplate — regenerating an unusable answer", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("bounds the regeneration at one retry", () => {
    expect(MAX_GENERATION_ATTEMPTS).toBe(2);
  });

  it("invalid JSON then valid → succeeds after 2 attempts, reason reported", async () => {
    mockFetch.mockResolvedValueOnce(invalidJson()).mockResolvedValueOnce(answer(VALID));
    const onRegenerate = vi.fn();

    const result = await generateFromTemplate({ ...PARAMS, onRegenerate }, IDENTITY);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.sequence.map((s) => s.daysSinceLastStep)).toEqual([0]);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(onRegenerate.mock.calls[0][0].attempt).toBe(2);
    expect(onRegenerate.mock.calls[0][0].reason).toContain("LLM returned invalid JSON");
    // Same request both times: nothing about the prompt changes on a regeneration.
    expect(mockFetch.mock.calls[1][1].body).toBe(mockFetch.mock.calls[0][1].body);
  });

  it("follow-ups without delays are dropped, never regenerated", async () => {
    mockFetch.mockResolvedValueOnce(answer(MISSING_FOLLOW_UP_DELAYS));

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.sequence).toHaveLength(1);
  });

  it("an unusable first-step delay then valid → succeeds, tokens cover both completions", async () => {
    mockFetch
      .mockResolvedValueOnce(answer(BAD_FIRST_DELAY, { in: 100, out: 40 }))
      .mockResolvedValueOnce(answer(VALID, { in: 110, out: 50 }));
    const onRegenerate = vi.fn();

    const result = await generateFromTemplate({ ...PARAMS, onRegenerate }, IDENTITY);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.sequence).toHaveLength(1);
    expect(result.tokensInput).toBe(210);
    expect(result.tokensOutput).toBe(90);
    expect(onRegenerate.mock.calls[0][0].reason).toContain("step(s) 1");
  });

  it("invalid JSON on every attempt → the same loud error as before, no more attempts", async () => {
    mockFetch.mockResolvedValue(invalidJson());

    await expect(generateFromTemplate(PARAMS, IDENTITY)).rejects.toThrow(
      "chat-service /complete failed for provider 'deepseek' model 'deepseek-pro': 502 - "
    );
    expect(mockFetch).toHaveBeenCalledTimes(MAX_GENERATION_ATTEMPTS);
  });

  it("an unusable first-step delay on every attempt → IncompleteSequenceError, no more attempts", async () => {
    mockFetch.mockResolvedValue(answer(BAD_FIRST_DELAY));

    await expect(generateFromTemplate(PARAMS, IDENTITY)).rejects.toThrow(IncompleteSequenceError);
    expect(mockFetch).toHaveBeenCalledTimes(MAX_GENERATION_ATTEMPTS);
  });

  it("402 is not regenerated", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ balance_cents: 1, required_cents: 5 }),
    });

    await expect(generateFromTemplate(PARAMS, IDENTITY)).rejects.toThrow(InsufficientCreditsError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, JSON.stringify({ error: "Provider is at capacity for this model.", retryable: true })],
    [502, JSON.stringify({ error: "LLM call failed. Please try again." })],
    [502, "Bad Gateway"],
    [503, "Service Unavailable"],
    [400, JSON.stringify({ error: "Provider rejected a request option.", retryable: false })],
  ])("upstream %i (%s) is not regenerated", async (status, text) => {
    mockFetch.mockResolvedValue({ ok: false, status, text: () => Promise.resolve(text) });

    await expect(generateFromTemplate(PARAMS, IDENTITY)).rejects.toThrow(`: ${status} - `);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a real upstream error after one unusable answer still fails loud without a third call", async () => {
    mockFetch
      .mockResolvedValueOnce(invalidJson())
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("down") });

    await expect(generateFromTemplate(PARAMS, IDENTITY)).rejects.toThrow(": 503 - down");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
