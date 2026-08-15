import { describe, it, expect } from "vitest";
import {
  GenerateRequestSchema,
  GenerateExpertQuotePitchRequestSchema,
} from "../../src/schemas";
import { CHAT_MODELS, MODEL_TO_PROVIDER } from "../../src/lib/chat-models";

const ALL_MODELS = [
  "haiku",
  "sonnet",
  "opus",
  "flash-lite",
  "flash",
  "flash-pro",
  "pro",
  "deepseek-flash",
  "deepseek-pro",
];

describe("model alias set", () => {
  it("is exactly the aliases chat-service accepts, each mapped to its provider", () => {
    expect([...CHAT_MODELS]).toEqual(ALL_MODELS);
    expect(MODEL_TO_PROVIDER).toEqual({
      haiku: "anthropic",
      sonnet: "anthropic",
      opus: "anthropic",
      "flash-lite": "google",
      flash: "google",
      "flash-pro": "google",
      pro: "google",
      "deepseek-flash": "vercel",
      "deepseek-pro": "vercel",
    });
  });

  it("routes both DeepSeek V4 models under the gateway provider slug chat-service expects", () => {
    expect(MODEL_TO_PROVIDER["deepseek-flash"]).toBe("vercel");
    expect(MODEL_TO_PROVIDER["deepseek-pro"]).toBe("vercel");
  });
});

describe("model input validation — POST /generate", () => {
  it("accepts every one of the 9 model aliases", () => {
    for (const model of ALL_MODELS) {
      const r = GenerateRequestSchema.safeParse({ type: "cold-email", variables: {}, model });
      expect(r.success, `model ${model} should be accepted`).toBe(true);
    }
  });

  it("rejects an unknown model alias (400-class, no silent default)", () => {
    const r = GenerateRequestSchema.safeParse({ type: "cold-email", variables: {}, model: "gpt-4" });
    expect(r.success).toBe(false);
  });

  it("names the whole accepted set in the rejection message the route returns as 400", () => {
    const r = GenerateRequestSchema.safeParse({ type: "cold-email", variables: {}, model: "gpt-4" });
    expect(r.success).toBe(false);
    // The route serializes `parsed.error.issues.map(i => i.message)` into the 400 body.
    const message = r.success ? "" : r.error.issues.map((i) => i.message).join(", ");
    for (const model of ALL_MODELS) {
      expect(message, `rejection should name ${model}`).toContain(model);
    }
  });

  it("treats model as optional (omitted is valid → service defaults to pro)", () => {
    const r = GenerateRequestSchema.safeParse({ type: "cold-email", variables: {} });
    expect(r.success).toBe(true);
  });
});

describe("model input validation — POST /generate-expert-quote-pitch", () => {
  it("accepts every one of the 9 model aliases", () => {
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
