import { describe, it, expect, vi, beforeEach } from "vitest";

// The real module (tests/setup.ts stubs it for every other suite).
const catalogue = await vi.importActual<typeof import("../../src/lib/chat-model-catalogue")>(
  "../../src/lib/chat-model-catalogue"
);

const served = {
  models: [
    { provider: "anthropic", model: "claude-opus", capabilityTier: "frontier", dynasty: "claude-opus" },
    { provider: "anthropic", model: "opus", capabilityTier: "frontier", dynasty: "claude-opus" },
    { provider: "google", model: "gemini-flash", capabilityTier: "cheap", dynasty: "gemini-flash" },
  ],
};
const okResponse = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") });

describe("chat-model-catalogue (chat-service GET /internal/models)", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    catalogue.resetChatModelCatalogueCache();
  });

  it("reads every accepted name with its provider and dynasty, once per cache window", async () => {
    mockFetch.mockResolvedValue(okResponse(served));
    expect(await catalogue.resolveChatModel("claude-opus")).toEqual({ model: "claude-opus", provider: "anthropic", dynasty: "claude-opus" });
    expect(await catalogue.resolveChatModel("opus")).toEqual({ model: "opus", provider: "anthropic", dynasty: "claude-opus" });
    expect((await catalogue.listChatModels()).map((e) => e.model)).toEqual(["claude-opus", "opus", "gemini-flash"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toMatch(/\/internal\/models$/);
  });

  it("re-reads once on a name it does not know, so a model chat-service just shipped is usable", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(served));
    await catalogue.listChatModels();
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    try {
      mockFetch.mockResolvedValueOnce(okResponse({ models: [...served.models, { provider: "openai", model: "gpt-terra", dynasty: "gpt-terra" }] }));
      expect((await catalogue.resolveChatModel("gpt-terra")).provider).toBe("openai");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an unknown name with 400 UNKNOWN_MODEL", async () => {
    mockFetch.mockResolvedValue(okResponse(served));
    const err = await catalogue.resolveChatModel("gpt-4").catch((e) => e);
    expect(err).toBeInstanceOf(catalogue.UnknownModelError);
    expect(err).toMatchObject({ status: 400, code: "UNKNOWN_MODEL", accepted: ["claude-opus", "opus", "gemini-flash"] });
  });

  it("fails loud (502) when chat-service's catalogue is unreadable or empty, never a guessed provider", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve("down"), json: () => Promise.resolve({}) });
    await expect(catalogue.resolveChatModel("claude-opus")).rejects.toBeInstanceOf(catalogue.ChatModelCatalogueError);
    catalogue.resetChatModelCatalogueCache();
    mockFetch.mockResolvedValue(okResponse({ models: [] }));
    await expect(catalogue.listChatModels()).rejects.toMatchObject({ status: 502, code: "MODEL_CATALOGUE_UNAVAILABLE" });
  });
});
