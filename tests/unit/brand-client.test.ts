import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { extractBrandFields } = await import("../../src/lib/brand-client.js");

const identity = { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-1" };

/** Helper to build the { brands, fields } response shape that brand-service returns */
function brandResponse(fields: Record<string, { value: unknown; cached?: boolean }>) {
  const fieldsObj: Record<string, { value: unknown; byBrand: Record<string, { value: unknown; cached: boolean }> }> = {};
  for (const [key, f] of Object.entries(fields)) {
    fieldsObj[key] = {
      value: f.value,
      byBrand: { "acme.com": { value: f.value, cached: f.cached ?? false } },
    };
  }
  return { brands: [{ brandId: "brand-1", domain: "acme.com", name: "Acme" }], fields: fieldsObj };
}

describe("brand-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts fields and returns a Map of key→string", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => brandResponse({
        industry: { value: "SaaS" },
        targetGeo: { value: ["US", "EU"], cached: true },
        unknown: { value: null },
      }),
    });

    const result = await extractBrandFields(
      [
        { key: "industry", description: "Industry" },
        { key: "targetGeo", description: "Geography" },
        { key: "unknown", description: "Unknown" },
      ],
      identity
    );

    expect(result.get("industry")).toBe("SaaS");
    expect(result.get("targetGeo")).toBe("US, EU");
    expect(result.has("unknown")).toBe(false); // null values skipped
  });

  it("returns empty Map when brand-service fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await extractBrandFields(
      [{ key: "industry", description: "Industry" }],
      identity
    );

    expect(result.size).toBe(0);
  });

  it("returns empty Map for empty fields array", async () => {
    const result = await extractBrandFields([], identity);

    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("coerces object values to JSON strings", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => brandResponse({
        socialProof: { value: { metrics: { users: 1500 } } },
      }),
    });

    const result = await extractBrandFields(
      [{ key: "socialProof", description: "Social proof" }],
      identity
    );

    expect(result.get("socialProof")).toBe('{"metrics":{"users":1500}}');
  });

  it("calls POST /orgs/brands/extract-fields (no path param) and forwards x-brand-id header", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => brandResponse({}),
    });

    await extractBrandFields(
      [{ key: "industry", description: "The brand's industry" }],
      identity
    );

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/orgs/brands/extract-fields");
    expect(url).not.toContain("/orgs/brands/brand-1/extract-fields");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      fields: [{ key: "industry", description: "The brand's industry" }],
    });
    expect(opts.headers["x-org-id"]).toBe("org-1");
    expect(opts.headers["x-brand-id"]).toBe("brand-1");
  });

  it("forwards CSV brand IDs via x-brand-id header", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => brandResponse({}),
    });

    const multiBrandIdentity = { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-1,brand-2,brand-3" };
    await extractBrandFields(
      [{ key: "industry", description: "Industry" }],
      multiBrandIdentity
    );

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["x-brand-id"]).toBe("brand-1,brand-2,brand-3");
  });
});
