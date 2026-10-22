import { describe, it, expect } from "vitest";
import {
  GenerateRequestSchema,
  GenerateExpertQuotePitchRequestSchema,
} from "../../src/schemas";
import { DEFAULT_MODEL } from "../../src/lib/chat-models";
import { listChatModels, resolveChatModel, UnknownModelError } from "../../src/lib/chat-model-catalogue";

// LLM-DYNASTY-1022-CG: the accepted names are chat-service's (stubbed in tests/setup.ts with its
// catalogue as served 2026-10-22), never a list kept here. The schema takes any non-empty name;
// the routes check it against the catalogue before any read or spend.
const DYNASTIES = [
  "claude-haiku", "claude-sonnet", "claude-opus", "claude-fable",
  "gemini-flash-lite", "gemini-flash", "gemini-pro",
  "deepseek-flash", "glm-flash", "glm", "kimi-k2", "kimi-k3",
  "gpt-astra", "gpt-sol", "gpt-terra",
];
const LEGACY = [
  "haiku", "sonnet", "opus", "fable", "flash-lite", "flash", "flash-pro", "pro",
  "deepseek-pro", "glm-pro", "kimi-flash", "kimi-pro", "gpt-pro",
];

describe("model names come from chat-service's catalogue", () => {
  it("accepts every served dynasty slug, each on its provider and dynasty", async () => {
    for (const slug of DYNASTIES) {
      const entry = await resolveChatModel(slug);
      expect(entry.dynasty, slug).toBe(slug);
    }
    expect((await resolveChatModel("claude-opus")).provider).toBe("anthropic");
    expect((await resolveChatModel("gemini-flash")).provider).toBe("google");
    expect((await resolveChatModel("kimi-k3")).provider).toBe("moonshot");
    expect((await resolveChatModel("gpt-terra")).provider).toBe("openai");
    expect((await resolveChatModel("glm")).provider).toBe("zai");
  });

  it("keeps every legacy alias, redirected to its dynasty", async () => {
    for (const alias of LEGACY) await expect(resolveChatModel(alias)).resolves.toBeTruthy();
    expect((await resolveChatModel("opus")).dynasty).toBe("claude-opus");
    expect((await resolveChatModel("flash-pro")).dynasty).toBe("gemini-flash");
    expect((await resolveChatModel("pro")).dynasty).toBe("gemini-pro");
  });

  it("refuses a name chat-service does not accept, naming what it accepts", async () => {
    const err = await resolveChatModel("gpt-4").catch((e) => e);
    expect(err).toBeInstanceOf(UnknownModelError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("UNKNOWN_MODEL");
    expect(err.accepted).toEqual((await listChatModels()).map((e) => e.model));
  });

  it("defaults to the Gemini Pro dynasty, the model the old `pro` default ran", async () => {
    expect(DEFAULT_MODEL).toBe("gemini-pro");
    expect((await resolveChatModel("pro")).dynasty).toBe((await resolveChatModel(DEFAULT_MODEL)).dynasty);
  });

  it("has no `_` in any name", async () => {
    for (const e of await listChatModels()) expect(e.model).not.toContain("_");
  });
});

describe("model field on the request schemas", () => {
  it("takes any non-empty name (checked against the catalogue by the route), optional", () => {
    for (const model of [...DYNASTIES, ...LEGACY, "gemini-3.8-flash"]) {
      expect(GenerateRequestSchema.safeParse({ type: "cold-email", variables: {}, model }).success, model).toBe(true);
      expect(GenerateExpertQuotePitchRequestSchema.safeParse({ variables: {}, model }).success, model).toBe(true);
    }
    expect(GenerateRequestSchema.safeParse({ type: "cold-email", variables: {} }).success).toBe(true);
    expect(GenerateRequestSchema.safeParse({ type: "cold-email", variables: {}, model: "" }).success).toBe(false);
  });
});
