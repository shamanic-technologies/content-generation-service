import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateFromTemplate } from "../../src/lib/chat-service-client";

function mockChatResponse(emails: Array<{ body: string; daysSinceLastStep: number }>) {
  const jsonPayload = { subject: "Test subject", emails };
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      content: JSON.stringify(jsonPayload),
      json: jsonPayload,
      tokensInput: 100,
      tokensOutput: 50,
      model: "claude-sonnet-4-6",
    }),
  };
}

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };

const PARAMS = {
  promptTemplate: "Write an email to {{name}}",
  variables: { name: "Test" },
};

describe("variable-length email sequences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a single-email sequence (length 1)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([{ body: "Hi there, quick note.", daysSinceLastStep: 0 }])
    );

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.sequence).toHaveLength(1);
    expect(result.sequence[0].step).toBe(1);
    expect(result.sequence[0].bodyText).toBe("Hi there, quick note.");
    expect(result.sequence[0].bodyHtml).toContain("<p>");
    expect(result.sequence[0].daysSinceLastStep).toBe(0);
  });

  // FOLLOWUP-JIT-1107: a generation is ONE email, whatever the stored template asks for.
  it("a template that answers with 3 emails yields only the first", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([
        { body: "Initial email", daysSinceLastStep: 0 },
        { body: "Follow-up 1", daysSinceLastStep: 3 },
        { body: "Follow-up 2", daysSinceLastStep: 7 },
      ])
    );

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.sequence).toHaveLength(1);
    expect(result.sequence[0]).toMatchObject({ step: 1, bodyText: "Initial email", daysSinceLastStep: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a 5-email answer yields only the first", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([
        { body: "Email 1", daysSinceLastStep: 0 },
        { body: "Email 2", daysSinceLastStep: 2 },
        { body: "Email 3", daysSinceLastStep: 4 },
        { body: "Email 4", daysSinceLastStep: 5 },
        { body: "Email 5", daysSinceLastStep: 10 },
      ])
    );

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.sequence.map((s) => s.bodyText)).toEqual(["Email 1"]);
  });

  it("asks the writer for one email and sends the template's own text unchanged", async () => {
    const template = "Write a 3-step sequence to {{name}}.\nEmail 1: open on their hiring.\nEmail 2: a case study.\nEmail 3: a breakup.";
    mockFetch.mockResolvedValueOnce(mockChatResponse([{ body: "Hi", daysSinceLastStep: 0 }]));

    await generateFromTemplate({ promptTemplate: template, variables: { name: "Ada" } }, IDENTITY);

    const sent = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sent.systemPrompt).toContain("exactly ONE item, the first email");
    expect(sent.systemPrompt).toContain("even when the prompt below describes follow-up emails");
    // The first email's instructions reach the writer exactly as the template wrote them.
    expect(sent.message).toBe("Write a 3-step sequence to Ada.\nEmail 1: open on their hiring.\nEmail 2: a case study.\nEmail 3: a breakup.");
  });

  it("a follow-up with no delay is no longer a reason to regenerate (it is dropped)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockChatResponse([
        { body: "Email 1", daysSinceLastStep: 0 },
        { body: "Email 2" } as unknown as { body: string; daysSinceLastStep: number },
      ])
    );

    const result = await generateFromTemplate(PARAMS, IDENTITY);

    expect(result.sequence).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
