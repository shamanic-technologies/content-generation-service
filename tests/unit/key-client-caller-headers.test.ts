import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fakeFetch = vi.fn();
vi.stubGlobal("fetch", fakeFetch);

describe("key-client caller headers", () => {
  beforeEach(() => {
    vi.resetModules();
    fakeFetch.mockReset();
    fakeFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ key: "decrypted-key" }),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("getByokKey sends X-Caller-Service, X-Caller-Method, X-Caller-Path headers", async () => {
    const { getByokKey } = await import("../../src/lib/key-client.js");

    await getByokKey("org_test", "anthropic", {
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

  it("getAppKey sends X-Caller-Service, X-Caller-Method, X-Caller-Path headers", async () => {
    const { getAppKey } = await import("../../src/lib/key-client.js");

    await getAppKey("my-app", "anthropic", {
      callerMethod: "POST",
      callerPath: "/generate/content",
    });

    expect(fakeFetch).toHaveBeenCalledOnce();
    const [, opts] = fakeFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "X-Caller-Service": "content-generation",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/generate/content",
    });
  });

  it("includes X-Api-Key alongside caller headers when KEY_SERVICE_API_KEY is set", async () => {
    vi.stubEnv("KEY_SERVICE_API_KEY", "test-api-key");

    const { getByokKey } = await import("../../src/lib/key-client.js");

    await getByokKey("org_test", "anthropic", {
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
