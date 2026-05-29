import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAssignmentFindFirst = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      featurePromptAssignment: { findFirst: (...args: unknown[]) => mockAssignmentFindFirst(...args) },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  featurePromptAssignment: { featureSlug: { name: "feature_slug" }, promptType: { name: "prompt_type" } },
}));

import {
  resolveAssignedPromptType,
  assertPromptVariablesMatch,
  PromptVariableMismatchError,
  PLATFORM_DEFAULT_PROMPT_TYPE,
} from "../../src/lib/prompt-assignment.js";
import { EXPERT_QUOTE_PITCH_TYPE } from "../../src/lib/expert-quote-pitch-template.js";

// ---------------------------------------------------------------------------
// resolveAssignedPromptType — resolution order
// ---------------------------------------------------------------------------
describe("resolveAssignedPromptType", () => {
  beforeEach(() => vi.clearAllMocks());

  it("platform default is the expert-quote-pitch type", () => {
    expect(PLATFORM_DEFAULT_PROMPT_TYPE).toBe(EXPERT_QUOTE_PITCH_TYPE);
  });

  it("returns platform default when featureSlug is undefined (no DB lookup)", async () => {
    expect(await resolveAssignedPromptType(undefined)).toBe(EXPERT_QUOTE_PITCH_TYPE);
    expect(mockAssignmentFindFirst).not.toHaveBeenCalled();
  });

  it("returns platform default when no assignment row exists", async () => {
    mockAssignmentFindFirst.mockResolvedValue(null);
    expect(await resolveAssignedPromptType("pr-expert-quote-opportunities")).toBe(EXPERT_QUOTE_PITCH_TYPE);
    expect(mockAssignmentFindFirst).toHaveBeenCalledTimes(1);
  });

  it("returns the assigned promptType when an assignment row exists", async () => {
    mockAssignmentFindFirst.mockResolvedValue({
      featureSlug: "pr-expert-quote-opportunities",
      promptType: "expert-quote-pitch-v2",
    });
    expect(await resolveAssignedPromptType("pr-expert-quote-opportunities")).toBe("expert-quote-pitch-v2");
  });
});

// ---------------------------------------------------------------------------
// assertPromptVariablesMatch — integrity guard
// ---------------------------------------------------------------------------
describe("assertPromptVariablesMatch", () => {
  const sourceVars = [
    { name: "brand", description: "" },
    { name: "request", description: "" },
    { name: "additionalContext", description: "" },
  ];

  it("passes when the {{var}} token set exactly matches the source declared names", () => {
    expect(() =>
      assertPromptVariablesMatch(
        "Profile {{brand}} answering {{request}} with {{additionalContext}}",
        "expert-quote-pitch",
        sourceVars
      )
    ).not.toThrow();
  });

  it("throws naming a dropped variable", () => {
    expect(() =>
      assertPromptVariablesMatch("Profile {{brand}} answering {{request}}", "expert-quote-pitch", sourceVars)
    ).toThrowError(PromptVariableMismatchError);
    try {
      assertPromptVariablesMatch("Profile {{brand}} answering {{request}}", "expert-quote-pitch", sourceVars);
    } catch (e) {
      expect((e as Error).message).toContain("additionalContext");
    }
  });

  it("throws on a renamed variable (missing old name surfaces)", () => {
    // request → query : request is missing from the submitted prompt
    try {
      assertPromptVariablesMatch(
        "Profile {{brand}} answering {{query}} with {{additionalContext}}",
        "expert-quote-pitch",
        sourceVars
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PromptVariableMismatchError);
      expect((e as Error).message).toContain("request");
    }
  });

  it("throws naming an added variable", () => {
    try {
      assertPromptVariablesMatch(
        "Profile {{brand}} answering {{request}} with {{additionalContext}} plus {{extra}}",
        "expert-quote-pitch",
        sourceVars
      );
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PromptVariableMismatchError);
      expect((e as Error).message).toContain("extra");
    }
  });
});
