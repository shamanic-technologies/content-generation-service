import { describe, it, expect, vi } from "vitest";
import { withSequenceDelays, IncompleteSequenceError } from "../../src/lib/sequence-delays";
import { generateFromTemplate } from "../../src/lib/chat-service-client";

// email-gateway POST /orgs/send 400s a whole send when any step lacks a numeric
// daysSinceLastStep. In prod (2026-09-24) two stored generations whose model had
// dropped step 1's delay were re-served on every lead retry: 82 failed sends.

describe("withSequenceDelays", () => {
  it("serves a first step with delay 0 as daysSinceLastStep: 0", () => {
    const out = withSequenceDelays([
      { step: 1, daysSinceLastStep: 0 },
      { step: 2, daysSinceLastStep: 3 },
    ]);
    expect(out[0].daysSinceLastStep).toBe(0);
    expect(out[1].daysSinceLastStep).toBe(3);
  });

  it("fills a MISSING first-step delay with 0", () => {
    const out = withSequenceDelays([
      { step: 1 },
      { step: 2, daysSinceLastStep: 3 },
      { step: 3, daysSinceLastStep: 7 },
    ] as Array<{ step: number; daysSinceLastStep?: unknown }>);
    expect(out.map((s) => s.daysSinceLastStep)).toEqual([0, 3, 7]);
  });

  it("fills a null first-step delay with 0", () => {
    const out = withSequenceDelays([{ daysSinceLastStep: null }]);
    expect(out[0].daysSinceLastStep).toBe(0);
  });

  it("returns a complete sequence with identical values", () => {
    const seq = [
      { step: 1, bodyText: "a", daysSinceLastStep: 0 },
      { step: 2, bodyText: "b", daysSinceLastStep: 4 },
    ];
    expect(withSequenceDelays(seq)).toEqual(seq);
  });

  it("fails loud when a later step has no delay, naming the steps", () => {
    expect(() =>
      withSequenceDelays(
        [{ daysSinceLastStep: 0 }, { daysSinceLastStep: 3 }, {}, { daysSinceLastStep: "7" }],
        "gen-1"
      )
    ).toThrowError(IncompleteSequenceError);
    try {
      withSequenceDelays([{}, {}, {}], "gen-1");
    } catch (err) {
      expect((err as IncompleteSequenceError).steps).toEqual([2, 3]);
      expect((err as Error).message).toContain("gen-1");
    }
  });

  it("rejects negative and non-finite delays on later steps", () => {
    expect(() => withSequenceDelays([{ daysSinceLastStep: 0 }, { daysSinceLastStep: -1 }])).toThrow(IncompleteSequenceError);
    expect(() => withSequenceDelays([{ daysSinceLastStep: 0 }, { daysSinceLastStep: NaN }])).toThrow(IncompleteSequenceError);
  });

  it("accepts an empty sequence", () => {
    expect(withSequenceDelays([])).toEqual([]);
  });
});

describe("generateFromTemplate — the model's delays", () => {
  const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };
  const PARAMS = { promptTemplate: "Write an email", variables: {} };

  function answer(emails: unknown[]) {
    const json = { subject: "S", emails };
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ content: JSON.stringify(json), json, tokensInput: 1, tokensOutput: 1, model: "glm-5.3-flash" }),
    };
  }

  it("serves daysSinceLastStep: 0 on step 1 when the model omitted it", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(answer([{ body: "a" }, { body: "b", daysSinceLastStep: 3 }]));
    vi.stubGlobal("fetch", mockFetch);
    const result = await generateFromTemplate(PARAMS, IDENTITY);
    expect(result.sequence.map((s) => s.daysSinceLastStep)).toEqual([0, 3]);
    vi.unstubAllGlobals();
  });

  it("fails loud when the model omitted a follow-up's delay", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(answer([{ body: "a", daysSinceLastStep: 0 }, { body: "b" }]));
    vi.stubGlobal("fetch", mockFetch);
    await expect(generateFromTemplate(PARAMS, IDENTITY)).rejects.toThrow(IncompleteSequenceError);
    vi.unstubAllGlobals();
  });
});
