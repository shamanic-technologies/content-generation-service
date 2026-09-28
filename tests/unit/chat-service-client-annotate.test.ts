import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateFromTemplate } from "../../src/lib/chat-service-client";

// `annotate` asks the SAME completion to report why each sentence exists. Pinned:
// absent → request byte-identical to before; present → the directive + an enum of
// the offered sources in the schema, highlights appended AFTER emails, and the
// model's report handed back raw for the caller to validate.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const PARAMS = { promptTemplate: "Write to {{name}}", variables: { name: "Sarah" } };
const SOURCES = [
  { id: "recipient.title", label: "The prospect's job title" },
  { id: "instruction", label: "A writing rule" },
];

function respond(json: Record<string, unknown>) {
  return { ok: true, status: 200, json: () => Promise.resolve({ content: "", json, tokensInput: 1, tokensOutput: 1, model: "m" }) };
}

const EMAILS = { subject: "S", emails: [{ body: "Hi Sarah,\n\nYou run sales.", daysSinceLastStep: 0 }] };

describe("generateFromTemplate annotate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends no directive, no highlights schema and returns no highlights when annotate is absent", async () => {
    mockFetch.mockResolvedValueOnce(respond(EMAILS));
    const result = await generateFromTemplate(PARAMS, IDENTITY);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.systemPrompt).not.toContain("Annotations");
    expect(body.responseSchema.properties.highlights).toBeUndefined();
    expect(body.responseSchema.required).toEqual(["subject", "emails"]);
    expect(result.highlights).toBeUndefined();
  });

  it("adds the directive listing every source and a highlights schema whose source is an enum of them", async () => {
    mockFetch.mockResolvedValueOnce(respond({ ...EMAILS, highlights: [{ text: "You run sales.", source: "recipient.title", reason: "Title says so" }] }));
    const result = await generateFromTemplate({ ...PARAMS, annotate: { sources: SOURCES } }, IDENTITY);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.systemPrompt).toContain("Annotations");
    expect(body.systemPrompt).toContain("recipient.title: The prospect's job title");
    expect(Object.keys(body.responseSchema.properties)).toEqual(["subject", "emails", "highlights"]);
    expect(body.responseSchema.required).toEqual(["subject", "emails", "highlights"]);
    expect(body.responseSchema.properties.highlights.items.properties.source.enum).toEqual(["recipient.title", "instruction"]);
    expect(body.responseSchema.properties.highlights.items.additionalProperties).toBeUndefined();
    expect(result.highlights).toEqual([{ text: "You run sales.", source: "recipient.title", reason: "Title says so" }]);
  });

  it("uses the strict item schema for anthropic models", async () => {
    mockFetch.mockResolvedValueOnce(respond({ ...EMAILS, highlights: [] }));
    await generateFromTemplate({ ...PARAMS, model: "sonnet", annotate: { sources: SOURCES } }, IDENTITY);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.responseSchema.additionalProperties).toBe(false);
    expect(body.responseSchema.properties.highlights.items.additionalProperties).toBe(false);
  });

  it("returns an empty list when the model omitted highlights", async () => {
    mockFetch.mockResolvedValueOnce(respond(EMAILS));
    const result = await generateFromTemplate({ ...PARAMS, annotate: { sources: SOURCES } }, IDENTITY);
    expect(result.highlights).toEqual([]);
  });
});
