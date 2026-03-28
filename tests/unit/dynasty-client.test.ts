import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock env vars before importing
process.env.WORKFLOW_SERVICE_URL = "http://workflow-test";
process.env.WORKFLOW_SERVICE_API_KEY = "wf-key";
process.env.FEATURES_SERVICE_URL = "http://features-test";
process.env.FEATURES_SERVICE_API_KEY = "feat-key";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  getWorkflowDynastyMap,
  getFeatureDynastyMap,
} = await import("../../src/lib/dynasty-client.js");

describe("dynasty-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolveWorkflowDynastySlugs", () => {
    it("returns versioned slugs from workflow-service", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slugs: ["cold-email", "cold-email-v2", "cold-email-v3"] }),
      });

      const slugs = await resolveWorkflowDynastySlugs("cold-email");

      expect(slugs).toEqual(["cold-email", "cold-email-v2", "cold-email-v3"]);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://workflow-test/workflows/dynasty/slugs?dynastySlug=cold-email",
        expect.objectContaining({ headers: { "X-Api-Key": "wf-key" } }),
      );
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const slugs = await resolveWorkflowDynastySlugs("nonexistent");

      expect(slugs).toEqual([]);
    });
  });

  describe("resolveFeatureDynastySlugs", () => {
    it("returns versioned slugs from features-service", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slugs: ["feat-alpha", "feat-alpha-v2"] }),
      });

      const slugs = await resolveFeatureDynastySlugs("feat-alpha");

      expect(slugs).toEqual(["feat-alpha", "feat-alpha-v2"]);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://features-test/features/dynasty/slugs?dynastySlug=feat-alpha",
        expect.objectContaining({ headers: { "X-Api-Key": "feat-key" } }),
      );
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const slugs = await resolveFeatureDynastySlugs("bad");

      expect(slugs).toEqual([]);
    });
  });

  describe("getWorkflowDynastyMap", () => {
    it("builds a reverse map from workflow dynasties", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dynasties: [
            { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
            { dynastySlug: "warm-intro", slugs: ["warm-intro", "warm-intro-v2", "warm-intro-v3"] },
          ],
        }),
      });

      const map = await getWorkflowDynastyMap();

      expect(map.get("cold-email")).toBe("cold-email");
      expect(map.get("cold-email-v2")).toBe("cold-email");
      expect(map.get("warm-intro-v3")).toBe("warm-intro");
      expect(map.size).toBe(5);
    });

    it("returns empty map on failure", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      const map = await getWorkflowDynastyMap();

      expect(map.size).toBe(0);
    });
  });

  describe("getFeatureDynastyMap", () => {
    it("builds a reverse map from feature dynasties", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          dynasties: [
            { dynastySlug: "feat-alpha", slugs: ["feat-alpha", "feat-alpha-v2"] },
          ],
        }),
      });

      const map = await getFeatureDynastyMap();

      expect(map.get("feat-alpha")).toBe("feat-alpha");
      expect(map.get("feat-alpha-v2")).toBe("feat-alpha");
    });
  });
});
