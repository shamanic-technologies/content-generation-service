import { describe, it, expect, vi } from "vitest";
import { generateFromTemplate } from "../../src/lib/anthropic-client";

// Capture the create call to inspect the system prompt
const mockCreate = vi.fn().mockResolvedValue({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ subject: "Quick question", body: "Hi John, a client of mine is doing interesting work in your space. Curious if you'd be open to hearing more?", followup1: "Just circling back.", followup2: "Last note — different angle." }),
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

describe("system prompt hides client identity", () => {
  it("passes a system prompt that forbids mentioning client name and website", async () => {
    await generateFromTemplate("fake-key", {
      promptTemplate: "Write an email to {{recipientName}}",
      variables: { recipientName: "John" },
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toBeDefined();
    expect(callArgs.system).toContain("client anonymous");
    expect(callArgs.system).toContain("conversion");
  });
});
