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

  it("decryptKey sends x-org-id and x-user-id as headers (not query params)", async () => {
    const { decryptKey } = await import("../../src/lib/key-client.js");

    await decryptKey("anthropic", "org-123", "user-456", {
      callerMethod: "POST",
      callerPath: "/generate/content",
    });

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url, opts] = fakeFetch.mock.calls[0];
    // URL should NOT contain orgId/userId query params
    expect(url).toContain("/keys/anthropic/decrypt");
    expect(url).not.toContain("orgId=");
    expect(url).not.toContain("userId=");
    // Identity must be sent as headers
    expect(opts.headers).toMatchObject({
      "x-org-id": "org-123",
      "x-user-id": "user-456",
    });
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
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "X-Caller-Service": "content-generation",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/generate",
    });
  });
});
