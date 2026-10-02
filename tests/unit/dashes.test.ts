import { describe, it, expect, vi, beforeEach } from "vitest";
import { stripDashes } from "../../src/lib/dashes";
import { resolveHighlights } from "../../src/lib/preview-highlights";
import { generateFromTemplate } from "../../src/lib/chat-service-client";

const DASHES = /[–—]|&(?:mdash|ndash|#8212|#8211|#x2014|#x2013);/i;

describe("stripDashes", () => {
  it("returns dash-free text byte-identical", () => {
    const t = "Hi Ana,\n\nQuick one: well-known co-founder, 10-20 calls.";
    expect(stripDashes(t)).toBe(t);
  });

  it("turns a dash between digits into a hyphen", () => {
    expect(stripDashes("10–20 calls")).toBe("10-20 calls");
    expect(stripDashes("2025 — 2026")).toBe("2025-2026");
    expect(stripDashes("10&ndash;20 calls")).toBe("10-20 calls");
  });

  it("replaces a mid-sentence dash with a comma, plain and entity forms", () => {
    expect(stripDashes("Saw your post — loved it")).toBe("Saw your post, loved it");
    expect(stripDashes("Saw your post—loved it")).toBe("Saw your post, loved it");
    expect(stripDashes("Saw your post – loved it")).toBe("Saw your post, loved it");
    expect(stripDashes("Saw your post &mdash; loved it")).toBe("Saw your post, loved it");
    expect(stripDashes("a &#8212; b &#x2013; c &#8211; d &#x2014; e")).toBe("a, b, c, d, e");
    expect(stripDashes("Thanks, — Kevin")).toBe("Thanks, Kevin");
  });

  it("drops a trailing dash and keeps a list marker as a hyphen", () => {
    expect(stripDashes("Worth a look —.")).toBe("Worth a look.");
    expect(stripDashes("Ideas —\nnext")).toBe("Ideas\nnext");
    expect(stripDashes("— one\n– two")).toBe("- one\n- two");
  });
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("generateFromTemplate strips dashes before anything is stored", () => {
  beforeEach(() => mockFetch.mockReset());

  it("subject, body and every follow-up come back with no em/en dash", async () => {
    const json = {
      subject: "Your 2025–2026 plan — a thought",
      emails: [
        { body: "Hi Ana,\n\nSaw your launch — nice.\n\nWe book 10&ndash;20 calls &mdash; monthly.", daysSinceLastStep: 0 },
        { body: "Following up—any interest? Teams of 5 – 50 use it.", daysSinceLastStep: 3 },
      ],
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ content: JSON.stringify(json), json, tokensInput: 1, tokensOutput: 1, model: "m" }),
    });

    const out = await generateFromTemplate(
      { promptTemplate: "Write to {{name}}", variables: { name: "Ana" } },
      { orgId: "o", userId: "u", runId: "r" }
    );

    expect(out.subject).toBe("Your 2025-2026 plan, a thought");
    expect(out.sequence[0].bodyText).toBe("Hi Ana,\n\nSaw your launch, nice.\n\nWe book 10-20 calls, monthly.");
    expect(out.sequence[1].bodyText).toBe("Following up, any interest? Teams of 5-50 use it.");
    for (const step of out.sequence) {
      expect(step.bodyText).not.toMatch(DASHES);
      expect(step.bodyHtml).not.toMatch(DASHES);
    }
  });
});

describe("preview highlights stay aligned with the stripped body", () => {
  it("a highlight quoting the model's dashed sentence still matches", () => {
    const body = stripDashes("We saw your launch — nice work.");
    const [h] = resolveHighlights(
      [{ text: "We saw your launch — nice work.", source: "instruction", reason: "r" }],
      body,
      [{ id: "instruction", kind: "instruction", label: "l", value: null }]
    );
    expect(h.text).toBe("We saw your launch, nice work.");
    expect(body.slice(h.start, h.end)).toBe(h.text);
  });
});
