import { describe, it, expect, vi } from "vitest";
import { generateFromTemplate } from "../../src/lib/anthropic-client";

function mockAnthropicResponse(emails: Array<{ body: string; daysSinceLastStep: number }>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ subject: "Test subject", emails }),
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: (...args: unknown[]) => mockCreate(...args) };
    },
  };
});

const PARAMS = {
  promptTemplate: "Write an email to {{name}}",
  variables: { name: "Test" },
};

describe("variable-length email sequences", () => {
  it("parses a single-email sequence (length 1)", async () => {
    mockCreate.mockResolvedValueOnce(
      mockAnthropicResponse([{ body: "Hi there, quick note.", daysSinceLastStep: 0 }])
    );

    const result = await generateFromTemplate("fake-key", PARAMS);

    expect(result.sequence).toHaveLength(1);
    expect(result.sequence[0].step).toBe(1);
    expect(result.sequence[0].bodyText).toBe("Hi there, quick note.");
    expect(result.sequence[0].bodyHtml).toContain("<p>");
    expect(result.sequence[0].daysSinceLastStep).toBe(0);
  });

  it("parses a 3-email sequence", async () => {
    mockCreate.mockResolvedValueOnce(
      mockAnthropicResponse([
        { body: "Initial email", daysSinceLastStep: 0 },
        { body: "Follow-up 1", daysSinceLastStep: 3 },
        { body: "Follow-up 2", daysSinceLastStep: 7 },
      ])
    );

    const result = await generateFromTemplate("fake-key", PARAMS);

    expect(result.sequence).toHaveLength(3);
    expect(result.sequence.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(result.sequence.map((s) => s.daysSinceLastStep)).toEqual([0, 3, 7]);
  });

  it("parses a 5-email sequence", async () => {
    mockCreate.mockResolvedValueOnce(
      mockAnthropicResponse([
        { body: "Email 1", daysSinceLastStep: 0 },
        { body: "Email 2", daysSinceLastStep: 2 },
        { body: "Email 3", daysSinceLastStep: 4 },
        { body: "Email 4", daysSinceLastStep: 5 },
        { body: "Email 5", daysSinceLastStep: 10 },
      ])
    );

    const result = await generateFromTemplate("fake-key", PARAMS);

    expect(result.sequence).toHaveLength(5);
    expect(result.sequence.map((s) => s.step)).toEqual([1, 2, 3, 4, 5]);
    expect(result.sequence.map((s) => s.daysSinceLastStep)).toEqual([0, 2, 4, 5, 10]);
  });

  it("uses daysSinceLastStep from the response, not hardcoded values", async () => {
    mockCreate.mockResolvedValueOnce(
      mockAnthropicResponse([
        { body: "Email 1", daysSinceLastStep: 0 },
        { body: "Email 2", daysSinceLastStep: 14 },
      ])
    );

    const result = await generateFromTemplate("fake-key", PARAMS);

    expect(result.sequence[0].daysSinceLastStep).toBe(0);
    expect(result.sequence[1].daysSinceLastStep).toBe(14);
  });
});
