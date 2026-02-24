import { describe, it, expect, vi } from "vitest";
import { generateFromTemplate } from "../../src/lib/anthropic-client";

const mockCreate = vi.fn().mockResolvedValue({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ subject: "Quick question", body: "Most community organizers focus on local impact — but that instinct to keep things small might be the biggest barrier to lasting change.\n\nI'm working with a client building a global network for funding public welfare initiatives, and they need experienced organizers as founding ambassadors.", followup1: "Just circling back.", followup2: "Last note — different angle." }),
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
});

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

describe("system prompt guides opening line and scam filtering", () => {
  it("guides away from compliment openings toward contrarian angles", async () => {
    await generateFromTemplate("fake-key", {
      promptTemplate: "Write an email to {{recipientName}}",
      variables: { recipientName: "Susan" },
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("contrarian");
    expect(callArgs.system).toContain("compliment");
  });

  it("includes scam filtering guidance", async () => {
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("Scam filter");
    expect(callArgs.system).toContain("crypto");
    expect(callArgs.system).toContain("dollar amounts");
  });

  it("emphasizes trust and allows mentioning paid roles", async () => {
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("trust");
    expect(callArgs.system).toContain("paid role");
  });

  it("guides toward simple, readable language", async () => {
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("Short sentences");
    expect(callArgs.system).toContain("read twice");
  });
});
