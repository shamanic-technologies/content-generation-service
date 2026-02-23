import { describe, it, expect, vi } from "vitest";
import {
  appendAiDisclaimer,
  AI_DISCLAIMER_HTML,
  AI_DISCLAIMER_TEXT,
  generateFromTemplate,
} from "../../src/lib/anthropic-client";

// ─── Unit tests for the helper ──────────────────────────────────────────────

describe("appendAiDisclaimer", () => {
  it("appends disclaimer HTML and text", () => {
    const result = appendAiDisclaimer("<p>Hello</p>", "Hello");

    expect(result.bodyHtml).toBe(`<p>Hello</p>${AI_DISCLAIMER_HTML}`);
    expect(result.bodyText).toBe(`Hello\n\n${AI_DISCLAIMER_TEXT}`);
  });

  it("disclaimer HTML uses italic grey small text", () => {
    expect(AI_DISCLAIMER_HTML).toContain("font-size:11px");
    expect(AI_DISCLAIMER_HTML).toContain("color:#999");
    expect(AI_DISCLAIMER_HTML).toContain("font-style:italic");
  });

  it("disclaimer text mentions AI and real person", () => {
    expect(AI_DISCLAIMER_TEXT).toContain("AI");
    expect(AI_DISCLAIMER_TEXT).toContain("real person");
  });
});

// ─── Integration with generateFromTemplate ──────────────────────────────────

const MOCK_RESPONSE = JSON.stringify({
  subject: "Quick question",
  body: "Hey Sarah,\n\nMost nonprofits treat community as a vanity metric.",
  followup1: "Just circling back on my last note.",
  followup2: "Last attempt — different angle this time.",
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text" as const, text: MOCK_RESPONSE }],
        usage: { input_tokens: 200, output_tokens: 80 },
      }),
    };
  },
}));

const baseParams = {
  promptTemplate: "Write a cold email to {{name}}",
  variables: { name: "Sarah" },
};

describe("generateFromTemplate with includeAiDisclaimer", () => {
  it("does NOT include disclaimer when includeAiDisclaimer is false", async () => {
    const result = await generateFromTemplate("fake-key", {
      ...baseParams,
      includeAiDisclaimer: false,
    });

    for (const step of result.sequence) {
      expect(step.bodyHtml).not.toContain(AI_DISCLAIMER_TEXT);
      expect(step.bodyText).not.toContain(AI_DISCLAIMER_TEXT);
    }
  });

  it("does NOT include disclaimer when includeAiDisclaimer is omitted", async () => {
    const result = await generateFromTemplate("fake-key", baseParams);

    for (const step of result.sequence) {
      expect(step.bodyHtml).not.toContain(AI_DISCLAIMER_TEXT);
      expect(step.bodyText).not.toContain(AI_DISCLAIMER_TEXT);
    }
  });

  it("appends disclaimer to ALL sequence steps when includeAiDisclaimer is true", async () => {
    const result = await generateFromTemplate("fake-key", {
      ...baseParams,
      includeAiDisclaimer: true,
    });

    expect(result.sequence).toHaveLength(3);

    for (const step of result.sequence) {
      expect(step.bodyHtml).toContain(AI_DISCLAIMER_HTML);
      expect(step.bodyText).toContain(AI_DISCLAIMER_TEXT);
    }
  });

  it("disclaimer appears at the end of bodyHtml, not the beginning", async () => {
    const result = await generateFromTemplate("fake-key", {
      ...baseParams,
      includeAiDisclaimer: true,
    });

    const html = result.sequence[0].bodyHtml;
    expect(html).toMatch(/.*<\/p><p style="font-size:11px/);
  });
});
