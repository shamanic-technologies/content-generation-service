import { describe, it, expect, vi, beforeEach } from "vitest";
import { annotatePreviewEmail, PREVIEW_ANNOTATE_MODEL } from "../../src/lib/preview-annotate-client";
import type { HighlightSource } from "../../src/lib/preview-highlights";

// The second call: reads the finished email + the offered inputs, returns the raw
// highlights. Billed by chat-service under the same identity headers as the writing call.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "b-1" };
const SOURCES: HighlightSource[] = [
  { id: "recipient.title", kind: "prospect", label: "The prospect's job title", value: "VP Sales" },
  { id: "instruction", kind: "instruction", label: "A writing rule", value: null },
];
const BODY = "Hi Sarah,\n\nYou run sales.";

function respond(json: unknown, ok = true, status = 200) {
  return { ok, status, text: () => Promise.resolve("boom"), json: () => Promise.resolve({ content: "", json, tokensInput: 7, tokensOutput: 3, model: "claude-sonnet-5-5" }) };
}

describe("annotatePreviewEmail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the finished body and the sources with their values, with the run's identity headers", async () => {
    mockFetch.mockResolvedValueOnce(respond({ highlights: [{ text: "You run sales.", source: "recipient.title", reason: "Title" }] }));
    const out = await annotatePreviewEmail({ bodyText: BODY, sources: SOURCES }, IDENTITY);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toMatch(/\/complete$/);
    expect(init.headers["x-org-id"]).toBe("org-1");
    expect(init.headers["x-run-id"]).toBe("run-1");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(PREVIEW_ANNOTATE_MODEL);
    expect(body.model).not.toMatch(/haiku/);
    expect(body.provider).toBe("anthropic");
    expect(body.message).toContain(BODY);
    expect(body.message).toContain("recipient.title: The prospect's job title = VP Sales");
    expect(body.responseSchema.properties.highlights.items.properties.source.enum).toEqual(["recipient.title", "instruction"]);
    expect(body.responseSchema.additionalProperties).toBe(false);
    expect(body.responseSchema.properties.highlights.items.additionalProperties).toBe(false);
    expect(out.highlights).toEqual([{ text: "You run sales.", source: "recipient.title", reason: "Title" }]);
    expect(out.tokensInput).toBe(7);
  });

  it("throws on a chat-service error, naming the call", async () => {
    mockFetch.mockResolvedValueOnce(respond({}, false, 402));
    await expect(annotatePreviewEmail({ bodyText: BODY, sources: SOURCES }, IDENTITY)).rejects.toThrow(/preview annotate.*402/);
  });

  it("throws when the answer carries no highlights array", async () => {
    mockFetch.mockResolvedValueOnce(respond({ subject: "x" }));
    await expect(annotatePreviewEmail({ bodyText: BODY, sources: SOURCES }, IDENTITY)).rejects.toThrow(/highlights array/);
  });
});
