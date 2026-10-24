import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// TPL-NAMED-HEAD-1023: a dynasty's identity is binary. A named dynasty's text may not tell the
// writer to hide the client (the "Named Free Offer" head was a blind text); a blind one's may
// not license naming it. The real guard runs; chat-service Jev is faked at the fetch boundary.

const mockJudgmentFindFirst = vi.fn();
const mockJudgmentInsert = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({ values: (v: Record<string, unknown>) => ({ onConflictDoNothing: () => mockJudgmentInsert(v) }) }),
    query: { templateNeutralityJudgments: { findFirst: (...a: unknown[]) => mockJudgmentFindFirst(...a) } },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  templateNeutralityJudgments: { __name: "template_neutrality_judgments", contentKey: { name: "content_key" } },
}));

const asked: Array<{ rule: "named" | "blind"; passage: string }> = [];

function fakeJev() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries<any>(body.questions)) {
      const passage = q.instructions.split('"""')[1];
      const rule = /client is NAMED/.test(q.instructions) ? "named" : "blind";
      asked.push({ rule, passage });
      const yes = rule === "named" ? /never reveal the client name/.test(passage) : /client name if recognizable/.test(passage);
      answers[k] = { type: "noul", noul: yes ? 0.86 : 0.05 };
    }
    return new Response(
      JSON.stringify({ model: "jev-latest", answers, usage: { inputTokens: 500, outputTokens: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

const HIDING = [
  "Write a short cold email to {{leadFirstName}}.",
  "Open on the free offer, then name the client.",
  "## Brand Intelligence (internal only: never reveal the client name or URL)",
  "{{brandExtractedFields}}",
].join("\n");
const NAMING = [
  "Write a short cold email to {{leadFirstName}}.",
  "Open on the free offer, then name the client.",
  "## Brand Intelligence (the client, named in the email)",
  "{{brandExtractedFields}}",
].join("\n");
const VARS = [
  { name: "leadFirstName", description: "The recipient's first name" },
  { name: "brandExtractedFields", description: "What the client sells" },
];
const caller = { mode: "platform" as const, support: { kind: "platform_llm" as const, reason: "test" } };

describe("a dynasty's text keeps its identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asked.length = 0;
    vi.stubGlobal("fetch", fakeJev());
    mockJudgmentFindFirst.mockResolvedValue(undefined);
    mockJudgmentInsert.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a named dynasty's text that tells the writer to hide the client, citing the passage", async () => {
    const { assertTemplateKeepsDynastyIdentity } = await import("../../src/lib/template-neutrality-guard.js");
    const err: any = await assertTemplateKeepsDynastyIdentity({
      type: "blind-discovery-email-website-visit-v34", prompt: HIDING, variables: VARS, caller, identity: "named",
    }).catch((e) => e);
    expect(err?.code).toBe("NAMED_TEMPLATE_HIDES_CLIENT");
    expect(err.status).toBe(422);
    expect(err.toResponseBody().passages).toEqual([
      { passage: "Brand Intelligence (internal only: never reveal the client name or URL)", location: "prompt", probability: 0.86 },
    ]);
    expect(asked.every((a) => a.rule === "named")).toBe(true);
    expect(mockJudgmentInsert).toHaveBeenCalledWith(expect.objectContaining({ ruleVersion: "named-1", neutral: false }));
  });

  it("accepts a named dynasty's text that names the client", async () => {
    const { assertTemplateKeepsDynastyIdentity } = await import("../../src/lib/template-neutrality-guard.js");
    await expect(
      assertTemplateKeepsDynastyIdentity({ type: "x-v35", prompt: NAMING, variables: VARS, caller, identity: "named" }),
    ).resolves.toBeUndefined();
  });

  it("judges a blind dynasty with the blind rule only, whatever its type prefix", async () => {
    const { assertTemplateKeepsDynastyIdentity } = await import("../../src/lib/template-neutrality-guard.js");
    await expect(
      assertTemplateKeepsDynastyIdentity({ type: "cold-email-v6", prompt: HIDING, variables: VARS, caller, identity: "blind" }),
    ).resolves.toBeUndefined();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a.rule === "blind")).toBe(true);
  });

  it("answers a resubmission from the stored verdict, no Jev call", async () => {
    mockJudgmentFindFirst.mockResolvedValue({
      neutral: false,
      passages: [{ text: "Brand Intelligence (internal only: never reveal the client name or URL)", location: "prompt", probability: 0.86 }],
    });
    const { assertNamedTemplateNamesClient } = await import("../../src/lib/template-neutrality-guard.js");
    await expect(
      assertNamedTemplateNamesClient({ type: "t", prompt: HIDING, variables: VARS, caller }),
    ).rejects.toMatchObject({ code: "NAMED_TEMPLATE_HIDES_CLIENT" });
    expect(asked).toHaveLength(0);
  });
});
