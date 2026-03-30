import { describe, it, expect, vi, beforeEach } from "vitest";
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

  it("disclaimer text mentions AI and client responding", () => {
    expect(AI_DISCLAIMER_TEXT).toContain("AI");
    expect(AI_DISCLAIMER_TEXT).toContain("our client will respond directly");
  });
});

// ─── Integration with generateFromTemplate ──────────────────────────────────

const MOCK_JSON = {
  subject: "Quick question",
  emails: [
    { body: "Hey Sarah,\n\nMost nonprofits treat community as a vanity metric.", daysSinceLastStep: 0 },
    { body: "Just circling back on my last note.", daysSinceLastStep: 3 },
    { body: "Last attempt — different angle this time.", daysSinceLastStep: 7 },
  ],
};
const MOCK_RESPONSE = JSON.stringify(MOCK_JSON);

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };

const baseParams = {
  promptTemplate: "Write a cold email to {{name}}",
  variables: { name: "Sarah" },
};

describe("generateFromTemplate with includeAiDisclaimer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        content: MOCK_RESPONSE,
        json: MOCK_JSON,
        tokensInput: 200,
        tokensOutput: 80,
        model: "claude-sonnet-4-6",
      }),
    });
  });

  it("does NOT include disclaimer when includeAiDisclaimer is false", async () => {
    const result = await generateFromTemplate({
      ...baseParams,
      includeAiDisclaimer: false,
    }, IDENTITY);

    for (const step of result.sequence) {
      expect(step.bodyHtml).not.toContain(AI_DISCLAIMER_TEXT);
      expect(step.bodyText).not.toContain(AI_DISCLAIMER_TEXT);
    }
  });

  it("does NOT include disclaimer when includeAiDisclaimer is omitted", async () => {
    const result = await generateFromTemplate(baseParams, IDENTITY);

    for (const step of result.sequence) {
      expect(step.bodyHtml).not.toContain(AI_DISCLAIMER_TEXT);
      expect(step.bodyText).not.toContain(AI_DISCLAIMER_TEXT);
    }
  });

  it("appends disclaimer to ALL sequence steps when includeAiDisclaimer is true", async () => {
    const result = await generateFromTemplate({
      ...baseParams,
      includeAiDisclaimer: true,
    }, IDENTITY);

    expect(result.sequence).toHaveLength(3);

    for (const step of result.sequence) {
      expect(step.bodyHtml).toContain(AI_DISCLAIMER_HTML);
      expect(step.bodyText).toContain(AI_DISCLAIMER_TEXT);
    }
  });

  it("disclaimer appears at the end of bodyHtml, not the beginning", async () => {
    const result = await generateFromTemplate({
      ...baseParams,
      includeAiDisclaimer: true,
    }, IDENTITY);

    const html = result.sequence[0].bodyHtml;
    expect(html).toMatch(/.*<\/p><p style="font-size:11px/);
  });
});
