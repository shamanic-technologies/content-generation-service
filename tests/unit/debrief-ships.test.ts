import { describe, it, expect } from "vitest";
import { renderShips } from "../../src/lib/debrief/ships.js";

// DRY-RUN-RENDER-1024: only a render that goes on to be published is an industry_update_video.
describe("renderShips", () => {
  it("a live render under a campaign ships", () => {
    expect(renderShips({ campaignId: "camp-1" })).toBe(true);
    expect(renderShips({ dryRun: false, campaignId: "camp-1" })).toBe(true);
  });
  it("a dry run never ships, even under a campaign", () => {
    expect(renderShips({ dryRun: true, campaignId: "camp-1" })).toBe(false);
  });
  it("a render with no campaign is a staff probe", () => {
    expect(renderShips({})).toBe(false);
    expect(renderShips({ campaignId: "" })).toBe(false);
    expect(renderShips({ campaignId: null })).toBe(false);
  });
});
