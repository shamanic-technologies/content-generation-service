import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCampaignBriefDirective, normalizeBrief, resolveCampaignBrief } from "../../src/lib/campaign-brief.js";
import { generateFromTemplate } from "../../src/lib/chat-service-client.js";

const BRIEF = "Every cold email names the offer's price: $25,000 for 30 days. Write as Kevin.";

describe("normalizeBrief", () => {
  it("reads a non-blank string, trimmed", () => {
    expect(normalizeBrief(`  ${BRIEF}\n`)).toBe(BRIEF);
  });

  it("reads absent, null, blank or non-string as no brief", () => {
    expect(normalizeBrief(undefined)).toBeNull();
    expect(normalizeBrief(null)).toBeNull();
    expect(normalizeBrief("   ")).toBeNull();
    expect(normalizeBrief(42)).toBeNull();
  });
});

describe("resolveCampaignBrief (ONE-BRIEF-1105 transition)", () => {
  it("the brief wins over the legacy instruction", () => {
    expect(resolveCampaignBrief({ brief: BRIEF, instruction: "old" })).toBe(BRIEF);
  });

  it("reads the legacy instruction only while the run sends no brief", () => {
    expect(resolveCampaignBrief({ instruction: "old" })).toBe("old");
    expect(resolveCampaignBrief({ brief: "  ", instruction: "old" })).toBe("old");
    expect(resolveCampaignBrief({})).toBeNull();
  });
});

describe("buildCampaignBriefDirective", () => {
  it("is empty without a brief", () => {
    expect(buildCampaignBriefDirective(null)).toBe("");
    expect(buildCampaignBriefDirective("  ")).toBe("");
  });

  it("carries the brief verbatim, wins over the template, never over format, voice or the thread", () => {
    const d = buildCampaignBriefDirective(BRIEF);
    expect(d).toContain(BRIEF);
    expect(d).toMatch(/overrides the template's angle/);
    expect(d).toMatch(/the thread and who they are to us win/);
    expect(d).toMatch(/never changes the output format above, our voice/);
  });
});

describe("generateFromTemplate with the campaign's brief", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const ok = () => new Response(JSON.stringify({
    content: "{}",
    json: { subject: "s", emails: [{ body: "Hi", daysSinceLastStep: 0 }] },
    tokensInput: 1,
    tokensOutput: 1,
    model: "m",
  }), { status: 200 });

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => vi.restoreAllMocks());

  async function systemPromptFor(
    brief: string | null | undefined,
    giveLists?: Parameters<typeof generateFromTemplate>[0]["giveLists"],
  ) {
    fetchSpy.mockResolvedValueOnce(ok());
    await generateFromTemplate(
      { promptTemplate: "Write a cold pitch.", variables: {}, brief, giveLists },
      { orgId: "o", userId: "u", runId: "r" },
    );
    return JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string).systemPrompt as string;
  }

  it("leaves the system prompt byte-identical when the run carries no brief", async () => {
    const none = await systemPromptFor(undefined);
    expect(await systemPromptFor(null)).toBe(none);
    expect(await systemPromptFor("   ")).toBe(none);
  });

  it("appends the brief to the system prompt the writer reads", async () => {
    const none = await systemPromptFor(undefined);
    expect(await systemPromptFor(BRIEF)).toBe(`${none}\n${buildCampaignBriefDirective(BRIEF)}`);
  });

  it("puts the brief after the offer's give lists, so it outranks them", async () => {
    const sp = await systemPromptFor(BRIEF, { giveForFree: ["A free audit"], neverGive: [] });
    expect(sp.indexOf("A free audit")).toBeGreaterThan(-1);
    expect(sp.indexOf(BRIEF)).toBeGreaterThan(sp.indexOf("A free audit"));
  });
});
