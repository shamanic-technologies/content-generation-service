import { describe, it, expect, vi, beforeEach } from "vitest";
import { unescapeLineBreaks, collapseEscapedLineBreaks } from "../../src/lib/escaped-line-breaks";
import {
  generateFromTemplate,
  generateExpertQuotePitchFromTemplate,
} from "../../src/lib/chat-service-client";

// The two-character sequence backslash + "n", as it arrives from an
// over-escaped model response. Written explicitly so the intent is unambiguous.
const BS = "\\";
const ESC_N = `${BS}n`;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };

const PARAMS = {
  promptTemplate: "Write an email to {{name}}",
  variables: { name: "Test" },
};

function mockChatResponse(
  emails: Array<{ body: string; daysSinceLastStep: number }>,
  subject = "Test subject"
) {
  const jsonPayload = { subject, emails };
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        content: JSON.stringify(jsonPayload),
        json: jsonPayload,
        tokensInput: 100,
        tokensOutput: 50,
        model: "claude-sonnet-4-6",
      }),
  };
}

function mockPitchResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        content,
        tokensInput: 100,
        tokensOutput: 50,
        model: "claude-sonnet-4-6",
      }),
  };
}

// The real cold email delivered 2026-07-30, three paragraphs.
const P1 = "Joby, I represent a team that handles proactive headhunting for UK boutique hotels.";
const P2 = "They specialize in finding elite operational leaders when a seat is sitting empty.";
const P3 = "Because top-tier leaders are rarely on the market, this group caps their roster.";

const REAL_BODY = [P1, P2, P3].join("\n\n");
const OVER_ESCAPED_BODY = [P1, P2, P3].join(`${ESC_N}${ESC_N}`);

describe("unescapeLineBreaks", () => {
  it("turns an escaped newline into a real newline", () => {
    expect(unescapeLineBreaks(`a${ESC_N}b`)).toBe("a\nb");
  });

  it("turns an escaped CRLF into a single real newline", () => {
    expect(unescapeLineBreaks(`a${BS}r${BS}nb`)).toBe("a\nb");
  });

  it("turns an escaped lone CR into a real newline", () => {
    expect(unescapeLineBreaks(`a${BS}rb`)).toBe("a\nb");
  });

  it("handles a double-escaped newline", () => {
    expect(unescapeLineBreaks(`a${BS}${BS}nb`)).toBe("a\nb");
  });

  it("leaves text without escaped line breaks byte-identical", () => {
    const text = "Real\n\nnewlines stay, and so does a tab\tcharacter.";
    expect(unescapeLineBreaks(text)).toBe(text);
  });
});

describe("collapseEscapedLineBreaks (single-line fields)", () => {
  it("collapses a run of escaped line breaks to one space", () => {
    expect(collapseEscapedLineBreaks(`Quick question${ESC_N}${ESC_N}about hiring`)).toBe(
      "Quick question about hiring"
    );
  });

  it("does not introduce a real newline", () => {
    expect(collapseEscapedLineBreaks(`a${ESC_N}b`)).not.toContain("\n");
  });

  it("leaves text without escaped line breaks byte-identical", () => {
    const text = "Quick question about hiring";
    expect(collapseEscapedLineBreaks(text)).toBe(text);
  });
});

describe("email body rendering — over-escaped newlines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders an over-escaped body identically to the same body with real newlines", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([{ body: OVER_ESCAPED_BODY, daysSinceLastStep: 0 }])
    );
    const escaped = await generateFromTemplate(PARAMS, IDENTITY);

    mockFetch.mockResolvedValueOnce(
      mockChatResponse([{ body: REAL_BODY, daysSinceLastStep: 0 }])
    );
    const real = await generateFromTemplate(PARAMS, IDENTITY);

    expect(escaped.sequence[0].bodyHtml).toBe(real.sequence[0].bodyHtml);
    expect(escaped.sequence[0].bodyText).toBe(real.sequence[0].bodyText);
  });

  it("splits an over-escaped body into paragraphs", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([{ body: OVER_ESCAPED_BODY, daysSinceLastStep: 0 }])
    );

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.sequence[0].bodyHtml).toBe(`<p>${P1}</p><p>${P2}</p><p>${P3}</p>`);
  });

  it("leaves no literal escape sequence in the emitted HTML or text", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([{ body: OVER_ESCAPED_BODY, daysSinceLastStep: 0 }])
    );

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.sequence[0].bodyHtml).not.toContain(ESC_N);
    expect(result.sequence[0].bodyText).not.toContain(ESC_N);
  });

  it("keeps a real-newline body exactly as before (single line break stays a <br>)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([{ body: `${P1}\n${P2}\n\n${P3}`, daysSinceLastStep: 0 }])
    );

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.sequence[0].bodyHtml).toBe(`<p>${P1}<br>${P2}</p><p>${P3}</p>`);
    expect(result.sequence[0].bodyText).toBe(`${P1}\n${P2}\n\n${P3}`);
  });

  it("renders a mixed body (some real newlines, some over-escaped)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([
        { body: `${P1}\n\n${P2}${ESC_N}${ESC_N}${P3}${ESC_N}Sent from the road`, daysSinceLastStep: 0 },
      ])
    );

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.sequence[0].bodyHtml).toBe(
      `<p>${P1}</p><p>${P2}</p><p>${P3}<br>Sent from the road</p>`
    );
    expect(result.sequence[0].bodyHtml).not.toContain(ESC_N);
  });

  it("fixes every step of a multi-step sequence", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([
        { body: `${P1}${ESC_N}${ESC_N}${P2}`, daysSinceLastStep: 0 },
        { body: `${P2}${ESC_N}${ESC_N}${P3}`, daysSinceLastStep: 3 },
      ])
    );

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.sequence.map((s) => s.bodyHtml)).toEqual([
      `<p>${P1}</p><p>${P2}</p>`,
      `<p>${P2}</p><p>${P3}</p>`,
    ]);
  });

  it("collapses over-escaped line breaks in the subject without adding a newline", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([{ body: P1, daysSinceLastStep: 0 }], `Quick question${ESC_N}${ESC_N}about hiring`)
    );

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.subject).toBe("Quick question about hiring");
    expect(result.subject).not.toContain("\n");
  });
});

describe("expert-quote pitch — over-escaped newlines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PITCH_PARAMS = {
    promptTemplate: "Pitch for {{journalistRequest}}",
    variables: { journalistRequest: "a quote" },
    minChars: 10,
    maxChars: 5000,
  };

  it("renders an over-escaped pitch identically to the same pitch with real newlines", async () => {
    mockFetch.mockResolvedValueOnce(mockPitchResponse(OVER_ESCAPED_BODY));
    const escaped = await generateExpertQuotePitchFromTemplate(PITCH_PARAMS, IDENTITY);

    mockFetch.mockResolvedValueOnce(mockPitchResponse(REAL_BODY));
    const real = await generateExpertQuotePitchFromTemplate(PITCH_PARAMS, IDENTITY);

    expect(escaped.pitch).toBe(real.pitch);
    expect(escaped.pitch).not.toContain(ESC_N);
    expect(escaped.pitch).toBe(REAL_BODY);
  });

  it("keeps a real-newline pitch exactly as before", async () => {
    mockFetch.mockResolvedValueOnce(mockPitchResponse(REAL_BODY));

    const result = await generateExpertQuotePitchFromTemplate(PITCH_PARAMS, IDENTITY);

    expect(result.pitch).toBe(REAL_BODY);
  });

  it("renders a mixed pitch (some real newlines, some over-escaped)", async () => {
    mockFetch.mockResolvedValueOnce(mockPitchResponse(`${P1}\n\n${P2}${ESC_N}${ESC_N}${P3}`));

    const result = await generateExpertQuotePitchFromTemplate(PITCH_PARAMS, IDENTITY);

    expect(result.pitch).toBe(REAL_BODY);
  });
});
