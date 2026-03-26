import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock before importing
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { getCampaignFeatureInputs, clearCampaignCache } = await import("../../src/lib/campaign-client.js");

const identity = { orgId: "org-1", userId: "user-1", runId: "run-1" };

describe("campaign-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCampaignCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches featureInputs from campaign-service", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        campaign: {
          id: "camp-1",
          orgId: "org-1",
          brandId: "brand-1",
          featureSlug: "cold-outreach",
          featureInputs: { angle: "sustainability", targetGeo: "US" },
        },
      }),
    });

    const result = await getCampaignFeatureInputs("camp-1", identity);

    expect(result).toEqual({ angle: "sustainability", targetGeo: "US" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/campaigns/camp-1");
  });

  it("caches featureInputs — second call does not fetch", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        campaign: { id: "camp-2", featureInputs: { angle: "AI" } },
      }),
    });

    const first = await getCampaignFeatureInputs("camp-2", identity);
    const second = await getCampaignFeatureInputs("camp-2", identity);

    expect(first).toEqual({ angle: "AI" });
    expect(second).toEqual({ angle: "AI" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when campaign-service returns non-ok", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await getCampaignFeatureInputs("camp-missing", identity);
    expect(result).toBeNull();
  });

  it("returns null when featureInputs is null", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        campaign: { id: "camp-3", featureInputs: null },
      }),
    });

    const result = await getCampaignFeatureInputs("camp-3", identity);
    expect(result).toBeNull();
  });

  it("forwards identity headers", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        campaign: { id: "camp-4", featureInputs: {} },
      }),
    });

    await getCampaignFeatureInputs("camp-4", {
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      campaignId: "camp-4",
      brandId: "brand-1",
    });

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(headers["x-campaign-id"]).toBe("camp-4");
    expect(headers["x-brand-id"]).toBe("brand-1");
  });
});
