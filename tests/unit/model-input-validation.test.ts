import { describe, it, expect } from "vitest";
import {
  GenerateRequestSchema,
  GenerateExpertQuotePitchRequestSchema,
} from "../../src/schemas";

const ALL_MODELS = ["haiku", "sonnet", "opus", "flash-lite", "flash", "flash-pro", "pro"];

describe("model input validation — POST /generate", () => {
  it("accepts every one of the 7 model aliases", () => {
    for (const model of ALL_MODELS) {
      const r = GenerateRequestSchema.safeParse({ type: "cold-email", variables: {}, model });
      expect(r.success, `model ${model} should be accepted`).toBe(true);
    }
  });

  it("rejects an unknown model alias (400-class, no silent default)", () => {
    const r = GenerateRequestSchema.safeParse({ type: "cold-email", variables: {}, model: "gpt-4" });
    expect(r.success).toBe(false);
  });

  it("treats model as optional (omitted is valid → service defaults to pro)", () => {
    const r = GenerateRequestSchema.safeParse({ type: "cold-email", variables: {} });
    expect(r.success).toBe(true);
  });
});

describe("model input validation — POST /generate-expert-quote-pitch", () => {
  it("accepts every one of the 7 model aliases", () => {
    for (const model of ALL_MODELS) {
      const r = GenerateExpertQuotePitchRequestSchema.safeParse({ variables: {}, model });
      expect(r.success, `model ${model} should be accepted`).toBe(true);
    }
  });

  it("rejects an unknown model alias", () => {
    const r = GenerateExpertQuotePitchRequestSchema.safeParse({ variables: {}, model: "nope" });
    expect(r.success).toBe(false);
  });

  it("treats model as optional", () => {
    const r = GenerateExpertQuotePitchRequestSchema.safeParse({ variables: {} });
    expect(r.success).toBe(true);
  });
});
