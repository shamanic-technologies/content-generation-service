import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fakeFetch = vi.fn();
vi.stubGlobal("fetch", fakeFetch);

describe("key-client caller headers", () => {
  beforeEach(() => {
    vi.resetModules();
    fakeFetch.mockReset();
    fakeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ key: "decrypted-key", keySource: "platform" }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("decryptKey sends X-Caller-Service, X-Caller-Method, X-Caller-Path headers", async () => {
    const { decryptKey } = await import("../../src/lib/key-client.js");

    await decryptKey("anthropic", "org-123", "user-456", {
      callerMethod: "POST",
      callerPath: "/generate",
    });

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [, opts] = fakeFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "X-Caller-Service": "content-generation",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/generate",
    });
  });

  it("decryptKey calls correct URL with orgId and userId", async () => {
    const { decryptKey } = await import("../../src/lib/key-client.js");

    await decryptKey("anthropic", "org-123", "user-456", {
      callerMethod: "POST",
      callerPath: "/generate/content",
    });

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url] = fakeFetch.mock.calls[0];
    expect(url).toContain("/keys/anthropic/decrypt");
    expect(url).toContain("orgId=org-123");
    expect(url).toContain("userId=user-456");
  });

  it("includes X-Api-Key alongside caller headers when KEY_SERVICE_API_KEY is set", async () => {
    vi.stubEnv("KEY_SERVICE_API_KEY", "test-api-key");

    const { decryptKey } = await import("../../src/lib/key-client.js");

    await decryptKey("anthropic", "org-123", "user-456", {
      callerMethod: "POST",
      callerPath: "/generate",
    });

    const [, opts] = fakeFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "X-Api-Key": "test-api-key",
      "X-Caller-Service": "content-generation",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/generate",
    });
  });
});
