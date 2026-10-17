import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateFromTemplate, MAX_GENERATION_ATTEMPTS } from "../../src/lib/chat-service-client";
import { BlindClientNamedError, MAX_BLIND_REWRITES } from "../../src/lib/blind-template";

// BLIND-WRITER-1017, need 1: an email written from a blind template never names the client,
// whatever the template, intel or brief say, guaranteed by a check on the answer.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const BLIND = { names: ["Living Vital"], domains: ["livingvital.ch"] };
const PARAMS = {
  promptTemplate: "Subject: use the client name if recognizable.\n{{brandExtractedFields}}",
  variables: { brandExtractedFields: "Living Vital makes supplements (livingvital.ch)." },
  model: "pro" as const,
};

function answer(subject: string, bodies: string[], tokens = 10) {
  const json = { subject, emails: bodies.map((body, i) => ({ body, daysSinceLastStep: i === 0 ? 0 : 3 })) };
  return { ok: true, status: 200, json: () => Promise.resolve({ content: "", json, tokensInput: tokens, tokensOutput: tokens, model: "gemini" }) };
}

const LEAK = answer("Living Vital for your clinic", ["Hi Ann,\n\nWir von Living Vital produzieren...", "See livingvital.ch"]);
const CLEAN = answer("Supplements for your clinic", ["Hi Ann,\n\nThe team I work with produces...", "Worth a look?"]);

describe("generateFromTemplate — blind template", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("appends the anonymity rule LAST to the system prompt", async () => {
    mockFetch.mockResolvedValueOnce(CLEAN);
    await generateFromTemplate({ ...PARAMS, blind: BLIND, instruction: "Push the spring promo." }, IDENTITY);
    const sys: string = JSON.parse(mockFetch.mock.calls[0][1].body).systemPrompt;
    expect(sys.indexOf("The client stays anonymous")).toBeGreaterThan(sys.indexOf("Push the spring promo."));
    expect(sys).toContain('"Living Vital", "livingvital.ch"');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rewrites an answer that names the client, from that draft, and serves the anonymous one", async () => {
    mockFetch.mockResolvedValueOnce(LEAK).mockResolvedValueOnce(CLEAN);
    const onBlindRewrite = vi.fn();
    const result = await generateFromTemplate({ ...PARAMS, blind: BLIND, onBlindRewrite }, IDENTITY);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const rewrite = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(rewrite.message).toContain("Wir von Living Vital produzieren");
    expect(rewrite.message).toContain('subject: "Living Vital"');
    expect(rewrite.systemPrompt).toBe(JSON.parse(mockFetch.mock.calls[0][1].body).systemPrompt);
    expect(result.subject).toBe("Supplements for your clinic");
    expect(result.sequence[0].bodyText).not.toMatch(/Living Vital/);
    expect(result.tokensInput).toBe(20);
    expect(onBlindRewrite).toHaveBeenCalledTimes(1);
  });

  it("fails loud when every rewrite still names the client: nothing is returned", async () => {
    mockFetch.mockResolvedValue(LEAK);
    await expect(generateFromTemplate({ ...PARAMS, blind: BLIND }, IDENTITY)).rejects.toBeInstanceOf(BlindClientNamedError);
    expect(mockFetch).toHaveBeenCalledTimes(1 + MAX_BLIND_REWRITES);
  });

  it("does nothing for a non-blind generation: same request, a named answer is served", async () => {
    mockFetch.mockResolvedValueOnce(LEAK).mockResolvedValueOnce(LEAK);
    const named = await generateFromTemplate(PARAMS, IDENTITY);
    await generateFromTemplate({ ...PARAMS, blind: null }, IDENTITY);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][1].body).toBe(mockFetch.mock.calls[1][1].body);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).systemPrompt).not.toMatch(/anonymous/);
    expect(named.subject).toBe("Living Vital for your clinic");
  });

  it("keeps the unusable-answer regeneration bound unchanged", () => {
    expect(MAX_GENERATION_ATTEMPTS).toBe(2);
  });
});
