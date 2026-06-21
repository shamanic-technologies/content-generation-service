import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchWithRetry, isTransientConnectError } from "../../src/lib/fetch-retry";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Zero-delay backoff so the suite never actually sleeps.
const NO_DELAY = { backoffMs: [0, 0, 0], maxRetries: 3 };

/** A `fetch failed` TypeError whose cause carries a connect-phase code. */
function connectError(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as Error & { cause: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

/** Node happy-eyeballs shape: AggregateError of per-address connect failures, under .cause. */
function aggregateConnectError(code: string): Error {
  const sub = Object.assign(new Error(code), { code });
  const agg = new AggregateError([sub], "");
  const err = new TypeError("fetch failed");
  (err as Error & { cause: unknown }).cause = agg;
  return err;
}

const okResponse = { ok: true, status: 200 } as Response;

describe("isTransientConnectError", () => {
  it("matches a direct connect-timeout cause", () => {
    expect(isTransientConnectError(connectError("UND_ERR_CONNECT_TIMEOUT"))).toBe(true);
  });

  it("matches ECONNREFUSED / ENETUNREACH / ETIMEDOUT", () => {
    expect(isTransientConnectError(connectError("ECONNREFUSED"))).toBe(true);
    expect(isTransientConnectError(connectError("ENETUNREACH"))).toBe(true);
    expect(isTransientConnectError(connectError("ETIMEDOUT"))).toBe(true);
  });

  it("matches a connect code nested in an AggregateError", () => {
    expect(isTransientConnectError(aggregateConnectError("UND_ERR_CONNECT_TIMEOUT"))).toBe(true);
  });

  it("does NOT match ECONNRESET (double-bill guard)", () => {
    expect(isTransientConnectError(connectError("ECONNRESET"))).toBe(false);
  });

  it("does NOT match an arbitrary error", () => {
    expect(isTransientConnectError(new Error("boom"))).toBe(false);
  });
});

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries a connect-timeout then succeeds", async () => {
    mockFetch
      .mockRejectedValueOnce(connectError("UND_ERR_CONNECT_TIMEOUT"))
      .mockResolvedValueOnce(okResponse);

    const res = await fetchWithRetry("http://chat/complete", { method: "POST" }, NO_DELAY);

    expect(res).toBe(okResponse);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry ECONNRESET — rethrows immediately (double-bill guard)", async () => {
    mockFetch.mockRejectedValueOnce(connectError("ECONNRESET"));

    await expect(
      fetchWithRetry("http://chat/complete", { method: "POST" }, NO_DELAY)
    ).rejects.toThrow("fetch failed");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a completed HTTP response (e.g. 500) — returns it untouched", async () => {
    const errResponse = { ok: false, status: 500 } as Response;
    mockFetch.mockResolvedValueOnce(errResponse);

    const res = await fetchWithRetry("http://chat/complete", { method: "POST" }, NO_DELAY);

    expect(res).toBe(errResponse);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rethrows the original error after exhausting retries", async () => {
    mockFetch.mockRejectedValue(connectError("UND_ERR_CONNECT_TIMEOUT"));

    await expect(
      fetchWithRetry("http://chat/complete", { method: "POST" }, NO_DELAY)
    ).rejects.toThrow("fetch failed");
    // initial attempt + 3 retries
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});
