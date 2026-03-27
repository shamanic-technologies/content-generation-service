import { describe, it, expect, vi } from "vitest";
import { generateFromTemplate } from "../../src/lib/anthropic-client";

const mockCreate = vi.fn().mockResolvedValue({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        subject: "Quick question",
        emails: [
          { body: "Hey Sarah,\n\nMost nonprofits treat community as a vanity metric — but the ones that last are built around shared purpose, not headcount.\n\nA client of mine is looking for a handful of organizers to help launch public goods initiatives. Would 30 minutes be worth a conversation?", daysSinceLastStep: 0 },
          { body: "Hey Sarah,\n\nJust circling back on my last note. Would love to connect for a quick chat.", daysSinceLastStep: 3 },
          { body: "Hey Sarah,\n\nDifferent angle — what if the biggest barrier to lasting community impact is actually thinking too small?", daysSinceLastStep: 7 },
        ],
      }),
    },
  ],
  usage: { input_tokens: 200, output_tokens: 80 },
});

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

describe("structured JSON output", () => {
  it("sends output_config with json_schema to Anthropic API", async () => {
    await generateFromTemplate("fake-key", {
      promptTemplate: "Write an email to {{recipientName}}",
      variables: { recipientName: "Sarah" },
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.output_config).toEqual({
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            subject: { type: "string" },
            emails: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  body: { type: "string" },
                  daysSinceLastStep: { type: "number" },
                },
                required: ["body", "daysSinceLastStep"],
                additionalProperties: false,
              },
            },
          },
          required: ["subject", "emails"],
          additionalProperties: false,
        },
      },
    });
  });

  it("parses JSON response into subject and 3-step sequence", async () => {
    const result = await generateFromTemplate("fake-key", {
      promptTemplate: "Write an email to {{recipientName}}",
      variables: { recipientName: "Sarah" },
    });

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

  it("sends a global system prompt with universal email rules", async () => {
    await generateFromTemplate("fake-key", {
      promptTemplate: "Write an email to {{recipientName}}",
      variables: { recipientName: "Sarah" },
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toBeDefined();
    expect(callArgs.system).toContain("NEVER include a sign-off");
    expect(callArgs.system).toContain("NEVER use placeholders");
  });
});
