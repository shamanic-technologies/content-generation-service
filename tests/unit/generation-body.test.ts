import { describe, it, expect } from "vitest";
import { resolveGenerationBody, withResolvedBody } from "../../src/lib/generation-body.js";
import { textToHtml } from "../../src/lib/text-to-html.js";

const REAL_EMAIL = "Hey Nicky,\n\nSaw your team shipped the new onboarding.\n\nWorth a chat?\n\nKevin";

describe("resolveGenerationBody", () => {
  it("serves the sequence's first step when the legacy columns are empty (every row since Feb 2026)", () => {
    const resolved = resolveGenerationBody({
      bodyText: null,
      bodyHtml: null,
      sequence: [
        { step: 1, bodyText: REAL_EMAIL, bodyHtml: textToHtml(REAL_EMAIL), daysSinceLastStep: 0 },
        { step: 2, bodyText: "Follow-up", bodyHtml: "<p>Follow-up</p>", daysSinceLastStep: 3 },
      ],
    });

    expect(resolved.bodyText).toBe(REAL_EMAIL);
    expect(resolved.bodyHtml).toBe(textToHtml(REAL_EMAIL));
    expect(resolved.bodySource).toBe("sequence");
  });

  it("picks step 1 even when the stored steps are out of order", () => {
    const resolved = resolveGenerationBody({
      sequence: [
        { step: 2, bodyText: "Follow-up", bodyHtml: "<p>Follow-up</p>" },
        { step: 1, bodyText: REAL_EMAIL, bodyHtml: "<p>first</p>" },
      ],
    });

    expect(resolved.bodyText).toBe(REAL_EMAIL);
  });

  it("skips a leading step that carries no copy", () => {
    const resolved = resolveGenerationBody({
      sequence: [
        { step: 1, bodyText: "", bodyHtml: "" },
        { step: 2, bodyText: REAL_EMAIL, bodyHtml: "<p>x</p>" },
      ],
    });

    expect(resolved.bodyText).toBe(REAL_EMAIL);
    expect(resolved.bodySource).toBe("sequence");
  });

  it("regenerates missing HTML with the generation-time conversion", () => {
    const resolved = resolveGenerationBody({ sequence: [{ step: 1, bodyText: REAL_EMAIL }] });

    expect(resolved.bodyHtml).toBe(textToHtml(REAL_EMAIL));
  });

  it("prefers the legacy columns when they are populated (pre-Feb-2026 rows unchanged)", () => {
    const resolved = resolveGenerationBody({
      bodyText: "column copy",
      bodyHtml: "<p>column copy</p>",
      sequence: [{ step: 1, bodyText: "sequence copy", bodyHtml: "<p>sequence copy</p>" }],
    });

    expect(resolved).toEqual({
      bodyText: "column copy",
      bodyHtml: "<p>column copy</p>",
      bodySource: "column",
    });
  });

  it("reports `none` — never an empty string — when the generation genuinely has no copy", () => {
    for (const sequence of [null, undefined, [], [{ step: 1, bodyText: "", bodyHtml: "" }], "not-an-array", [null]]) {
      const resolved = resolveGenerationBody({ bodyText: null, bodyHtml: "", sequence });
      expect(resolved).toEqual({ bodyText: null, bodyHtml: null, bodySource: "none" });
    }
  });

  it("treats a whitespace-only body as no copy", () => {
    expect(resolveGenerationBody({ bodyText: "   \n ", sequence: [] }).bodySource).toBe("none");
  });
});

describe("withResolvedBody", () => {
  it("keeps every other field, sequence included", () => {
    const sequence = [
      { step: 1, bodyText: REAL_EMAIL, bodyHtml: "<p>x</p>" },
      { step: 2, bodyText: "Follow-up", bodyHtml: "<p>Follow-up</p>" },
    ];
    const row = {
      id: "gen-1",
      subject: "Quick question",
      campaignId: "camp-1",
      leadId: "lead-1",
      bodyText: null,
      bodyHtml: null,
      sequence,
    };

    expect(withResolvedBody(row)).toEqual({
      ...row,
      bodyText: REAL_EMAIL,
      bodyHtml: "<p>x</p>",
      bodySource: "sequence",
    });
  });
});
