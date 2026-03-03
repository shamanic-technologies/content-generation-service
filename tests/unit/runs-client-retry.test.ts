import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the fetch mock so we can control responses
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Stub env before importing
vi.stubEnv("RUNS_SERVICE_URL", "https://runs.test");
vi.stubEnv("RUNS_SERVICE_API_KEY", "test-key");

// Import after mocking
const { addCosts, createRun, getRun, updateRun } = await import(
  "../../src/lib/runs-client.js"
);

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("runs-client retry logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should succeed on first attempt without retrying", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: "run-1" }));

    const result = await createRun({
      orgId: "org_1",
      serviceName: "test",
      taskName: "test",
    });

    expect(result).toEqual({ id: "run-1" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should retry on 502 and succeed on second attempt", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(502, { error: "Bad Gateway" }))
      .mockResolvedValueOnce(jsonResponse(200, { costs: [] }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await addCosts("run-1", [
      { costName: "anthropic-sonnet-4.6-tokens-input", quantity: 100, costSource: "platform" as const },
    ]);

    expect(result).toEqual({ costs: [] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Retry 1/3")
    );

    warnSpy.mockRestore();
  });

  it("should retry on 500 and succeed on third attempt", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(500, { error: "Internal" }))
      .mockResolvedValueOnce(jsonResponse(503, { error: "Unavailable" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "run-1" }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getRun("run-1");

    expect(result).toEqual({ id: "run-1" });
    expect(mockFetch).toHaveBeenCalledTimes(3);

    warnSpy.mockRestore();
  });

  it("should throw after exhausting all retries on transient errors", async () => {
    mockFetch
      .mockResolvedValue(jsonResponse(502, { error: "Bad Gateway" }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      updateRun("run-1", "completed")
    ).rejects.toThrow("runs-service PATCH /v1/runs/run-1 failed: 502");

    // 1 initial + 3 retries = 4 total attempts
    expect(mockFetch).toHaveBeenCalledTimes(4);

    warnSpy.mockRestore();
  });

  it("should NOT retry on 4xx errors", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(400, { error: "Bad Request" })
    );

    await expect(
      addCosts("run-1", [{ costName: "bad", quantity: 1, costSource: "platform" as const }])
    ).rejects.toThrow("runs-service POST /v1/runs/run-1/costs failed: 400");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should NOT retry on 404 errors", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(404, { error: "Not Found" })
    );

    await expect(getRun("nonexistent")).rejects.toThrow(
      "runs-service GET /v1/runs/nonexistent failed: 404"
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should retry on 504 Gateway Timeout", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(504, { error: "Gateway Timeout" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "run-1" }));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getRun("run-1");

    expect(result).toEqual({ id: "run-1" });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});
