import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateFromTemplate } from "../../src/lib/chat-service-client";

// The preview's WRITING request is the one a /generate run sends for the same template,
// model and variables: no annotation directive, no highlights field in the schema
// (owner 2026-10-16). The "why" per sentence is a second call (preview-annotate-client.ts).

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const EMAILS = { subject: "S", emails: [{ body: "Hi Sarah,\n\nYou run sales.", daysSinceLastStep: 0 }] };

function respond() {
  return { ok: true, status: 200, json: () => Promise.resolve({ content: "", json: EMAILS, tokensInput: 1, tokensOutput: 1, model: "m" }) };
}

const BASE = {
  promptTemplate: "Write to {{name}}",
  variables: { name: "Sarah" },
  campaignContext: { audience: "Heads of sales" },
  giveLists: { giveForFree: ["a free audit"], neverGive: ["discounts"] },
};

describe("preview writing call = /generate call", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const model of ["pro", "sonnet", "glm-pro"] as const) {
    it(`is byte-identical to a /generate request with no lead language and no instruction (${model})`, async () => {
      mockFetch.mockResolvedValue(respond());
      // What POST /preview-email passes.
      await generateFromTemplate({ ...BASE, model }, IDENTITY);
      // What POST /generate passes for the same inputs (no lead language, no campaign instruction).
      await generateFromTemplate({ ...BASE, model, language: null, instruction: null, onRegenerate: () => {} }, IDENTITY);
      const preview = mockFetch.mock.calls[0][1].body as string;
      const generate = mockFetch.mock.calls[1][1].body as string;
      expect(preview).toBe(generate);
      const body = JSON.parse(preview);
      expect(Object.keys(body).sort()).toEqual(["message", "model", "provider", "responseSchema", "systemPrompt"]);
      expect(body.systemPrompt).not.toMatch(/annotation|highlight/i);
      expect(body.responseSchema.properties.highlights).toBeUndefined();
      expect(body.responseSchema.required).toEqual(["subject", "emails"]);
    });
  }
});
