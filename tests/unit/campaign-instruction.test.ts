import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildCampaignInstructionDirective,
  normalizeInstruction,
} from "../../src/lib/campaign-instruction.js";
import { generateFromTemplate } from "../../src/lib/chat-service-client.js";

const INSTRUCTION =
  "You write as Kevin to a signup who never talked with us. Thank them and ask ONE open question.";

describe("normalizeInstruction", () => {
  it("reads a non-blank string, trimmed", () => {
    expect(normalizeInstruction(`  ${INSTRUCTION}\n`)).toBe(INSTRUCTION);
  });

  it("reads absent, null, blank or non-string as no instruction", () => {
    expect(normalizeInstruction(undefined)).toBeNull();
    expect(normalizeInstruction(null)).toBeNull();
    expect(normalizeInstruction("   ")).toBeNull();
    expect(normalizeInstruction(42)).toBeNull();
  });
});

describe("buildCampaignInstructionDirective", () => {
  it("is empty without an instruction", () => {
    expect(buildCampaignInstructionDirective(null)).toBe("");
    expect(buildCampaignInstructionDirective("  ")).toBe("");
  });

  it("carries the instruction verbatim and states that it wins over the template", () => {
    const d = buildCampaignInstructionDirective(INSTRUCTION);
    expect(d).toContain(INSTRUCTION);
    expect(d).toMatch(/overrides the prompt above/);
    expect(d).toMatch(/never changes the JSON format/);
  });
});

describe("generateFromTemplate with the campaign's instruction", () => {
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
    instruction: string | null | undefined,
    giveLists?: Parameters<typeof generateFromTemplate>[0]["giveLists"],
  ) {
    fetchSpy.mockResolvedValueOnce(ok());
    await generateFromTemplate(
      { promptTemplate: "Write a cold pitch.", variables: {}, instruction, giveLists },
      { orgId: "o", userId: "u", runId: "r" },
    );
    return JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string).systemPrompt as string;
  }

  it("leaves the system prompt byte-identical when the run carries no instruction", async () => {
    const none = await systemPromptFor(undefined);
    expect(await systemPromptFor(null)).toBe(none);
    expect(await systemPromptFor("   ")).toBe(none);
  });

  it("appends the instruction to the system prompt the writer reads", async () => {
    const none = await systemPromptFor(undefined);
    expect(await systemPromptFor(INSTRUCTION)).toBe(`${none}\n${buildCampaignInstructionDirective(INSTRUCTION)}`);
  });

  it("puts the instruction LAST, after the offer's give lists, so it outranks them", async () => {
    const sp = await systemPromptFor(INSTRUCTION, { giveForFree: ["A free audit"], neverGive: [] });
    expect(sp.indexOf("A free audit")).toBeGreaterThan(-1);
    expect(sp.indexOf(INSTRUCTION)).toBeGreaterThan(sp.indexOf("A free audit"));
  });
});
