import { describe, it, expect } from "vitest";
import { repairSequence, hasEscapedLineBreak } from "../../src/lib/escaped-line-break-repair";
import { textToHtml } from "../../src/lib/text-to-html";

// The two-character sequence backslash + "n", as it arrives from an
// over-escaped model response. Written explicitly so the intent is unambiguous.
const BS = "\\";
const ESC_N = `${BS}n`;

// The real stored generation for lead 2580d548-01a6-4745-8f9e-51494f1e162f
// (Joby Wells), whose step 1 is the row cited in the repair brief.
const P1 = "Joby, I represent a team that handles proactive headhunting for UK boutique hotels.";
const P2 = "They specialize in finding elite operational leaders when a seat is sitting empty.";
const P3 = "Because top-tier leaders are rarely on the market, this group caps their roster.";

const REAL_TEXT = [P1, P2, P3].join("\n\n");
const OVER_ESCAPED_TEXT = [P1, P2, P3].join(`${ESC_N}${ESC_N}`);

/** A step exactly as the pre-#153 writer stored it: html is `<p>` + the raw text. */
function dirtyStep(step: number) {
  return {
    step,
    bodyText: OVER_ESCAPED_TEXT,
    bodyHtml: `<p>${OVER_ESCAPED_TEXT}</p>`,
    daysSinceLastStep: step === 1 ? 0 : 3,
  };
}

/** A step written after #153: real newlines, html split into paragraphs. */
function cleanStep(step: number) {
  return {
    step,
    bodyText: REAL_TEXT,
    bodyHtml: textToHtml(REAL_TEXT),
    daysSinceLastStep: step === 1 ? 0 : 3,
  };
}

describe("hasEscapedLineBreak", () => {
  it("is true for text carrying an over-escaped line break", () => {
    expect(hasEscapedLineBreak(OVER_ESCAPED_TEXT)).toBe(true);
    expect(hasEscapedLineBreak(`a${BS}r${BS}nb`)).toBe(true);
  });

  it("is false for text with real newlines, and for non-strings", () => {
    expect(hasEscapedLineBreak(REAL_TEXT)).toBe(false);
    expect(hasEscapedLineBreak(undefined)).toBe(false);
    expect(hasEscapedLineBreak(null)).toBe(false);
    expect(hasEscapedLineBreak(42)).toBe(false);
  });
});

describe("repairSequence — dirty row", () => {
  it("unescapes the text and regenerates the html from the repaired text", () => {
    const repair = repairSequence([dirtyStep(1)]);

    expect(repair).not.toBeNull();
    expect(repair!.repairedSteps).toBe(1);

    const [repaired] = repair!.sequence as Array<Record<string, unknown>>;
    expect(repaired.bodyText).toBe(REAL_TEXT);
    // Regenerated, not patched in place: three paragraphs, no visible backslash-n.
    expect(repaired.bodyHtml).toBe(textToHtml(REAL_TEXT));
    expect(repaired.bodyHtml).toBe(`<p>${P1}</p><p>${P2}</p><p>${P3}</p>`);
    expect(repaired.bodyHtml as string).not.toContain(ESC_N);
    expect(repaired.bodyText as string).not.toContain(ESC_N);
  });

  it("repairs every dirty step and preserves the other step fields", () => {
    const repair = repairSequence([dirtyStep(1), dirtyStep(2), dirtyStep(3)]);

    expect(repair!.repairedSteps).toBe(3);
    const steps = repair!.sequence as Array<Record<string, unknown>>;
    expect(steps.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(steps.map((s) => s.daysSinceLastStep)).toEqual([0, 3, 3]);
  });

  it("leaves the clean steps of a dirty row byte-identical", () => {
    const clean = cleanStep(2);
    const repair = repairSequence([dirtyStep(1), clean]);

    expect(repair!.repairedSteps).toBe(1);
    // Same object reference — the clean step is never rewritten.
    expect((repair!.sequence as unknown[])[1]).toBe(clean);
  });

  it("throws rather than patching html in place when there is no text to regenerate from", () => {
    expect(() =>
      repairSequence([{ step: 1, bodyHtml: `<p>${OVER_ESCAPED_TEXT}</p>` }])
    ).toThrow(/no string bodyText/);
  });
});

describe("repairSequence — clean row", () => {
  it("returns null for a sequence written after the generation-time fix", () => {
    expect(repairSequence([cleanStep(1), cleanStep(2)])).toBeNull();
  });

  it("returns null for a non-sequence value", () => {
    expect(repairSequence(null)).toBeNull();
    expect(repairSequence(undefined)).toBeNull();
    expect(repairSequence({ not: "an array" })).toBeNull();
  });

  it("returns null for text carrying a legitimate backslash", () => {
    const withBackslash = { step: 1, bodyText: `Path C:${BS}temp is fine`, bodyHtml: "<p>x</p>" };
    expect(repairSequence([withBackslash])).toBeNull();
  });
});

describe("repairSequence — idempotency", () => {
  it("a second pass over an already-repaired sequence changes nothing", () => {
    const first = repairSequence([dirtyStep(1), dirtyStep(2)]);
    expect(first).not.toBeNull();

    const second = repairSequence(first!.sequence);
    expect(second).toBeNull();
  });
});
