import { describe, it, expect } from "vitest";
import { buildTrackingHeaders } from "../../src/lib/tracking.js";

/**
 * Unit tests for the single allowlist-driven downstream-header builder.
 * Guards against regression of x-audience-id propagation + the egress contract
 * (optional fields emitted only when present, never empty).
 */
describe("buildTrackingHeaders", () => {
  it("emits x-audience-id when audienceId is present", () => {
    const h = buildTrackingHeaders({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      campaignId: "camp-1",
      brandId: "brand-1",
      workflowSlug: "wf-1",
      featureSlug: "feat-1",
      audienceId: "aud-1",
    });
    expect(h).toEqual({
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
      "x-campaign-id": "camp-1",
      "x-brand-id": "brand-1",
      "x-workflow-slug": "wf-1",
      "x-feature-slug": "feat-1",
      "x-audience-id": "aud-1",
    });
  });

  it("omits x-audience-id when audienceId is absent (no throw)", () => {
    const h = buildTrackingHeaders({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      campaignId: "camp-1",
    });
    expect(h["x-audience-id"]).toBeUndefined();
    expect(h).toEqual({
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
      "x-campaign-id": "camp-1",
    });
  });

  it("emits only x-org-id + x-user-id when no optional fields are set", () => {
    const h = buildTrackingHeaders({ orgId: "org-1", userId: "user-1" });
    expect(h).toEqual({ "x-org-id": "org-1", "x-user-id": "user-1" });
  });
});
