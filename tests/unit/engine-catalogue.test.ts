import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelCatalogue } from "../../src/lib/pipe-from-step.js";

// RESEARCH-BY-ENGINE-1113-CG: the Engine of a (channel x step pair) = its catalogue `outcome`, else its `to` step.
const fetchChannelCatalogue = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/pipe-from-step.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/pipe-from-step.js")>();
  return { ...actual, fetchChannelCatalogue };
});

const { engineOfPair, enginesOnCatalogue, pairsOfEngine, assertEngine, engineOfPairLive, EngineCatalogueError } = await import("../../src/lib/engine-catalogue.js");

const CATALOGUE: ChannelCatalogue = {
  channels: [
    { slug: "sales-cold-email-outreach", channelType: "outbound", stepTransitions: [
      { legKey: "lead_found_to_conversation", from: { key: "lead_found" }, to: { key: "conversation" }, outcome: "email_sent" },
      { legKey: "lead_found_to_website_visit", from: { key: "lead_found" }, to: { key: "website_visit" }, outcome: null },
    ] },
    { slug: "founder-hello", stepTransitions: [{ legKey: "start_to_conversation", from: null, to: { key: "conversation" }, outcome: "whatsapp_message_sent" }] },
  ],
  legKeyCorrespondence: [{ channelType: "outbound", legacyLegKey: "start_to_conversation", legKey: "lead_found_to_conversation" }],
};

describe("engine catalogue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("an Engine is the pair's outcome, else its to step; a legacy step spelling resolves; unknown = null", () => {
    expect(engineOfPair(CATALOGUE, { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" })).toBe("email_sent");
    expect(engineOfPair(CATALOGUE, { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit" })).toBe("website_visit");
    expect(engineOfPair(CATALOGUE, { featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" })).toBe("email_sent");
    expect(engineOfPair(CATALOGUE, { featureSlug: "nope", legKey: "x" })).toBeNull();
    expect([...enginesOnCatalogue(CATALOGUE)].sort()).toEqual(["email_sent", "website_visit", "whatsapp_message_sent"]);
  });

  it("keeps only the pairs of one Engine", () => {
    const pairs = [
      { slug: "a", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" },
      { slug: "b", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit" },
      { slug: "c", featureSlug: "gone", legKey: "x" },
    ];
    expect(pairsOfEngine(CATALOGUE, pairs, "email_sent").map((p) => p.slug)).toEqual(["a"]);
  });

  it("assertEngine: 404 UNKNOWN_ENGINE, 502 when the catalogue is unreadable", async () => {
    fetchChannelCatalogue.mockResolvedValue(CATALOGUE);
    await expect(assertEngine("email_sent")).resolves.toBe("email_sent");
    await expect(assertEngine("email_snt")).rejects.toMatchObject({ status: 404, code: "UNKNOWN_ENGINE" });
    fetchChannelCatalogue.mockRejectedValue(new Error("features down"));
    const err = await assertEngine("email_sent").catch((e) => e);
    expect(err).toBeInstanceOf(EngineCatalogueError);
    expect(err).toMatchObject({ status: 502, code: "ENGINE_CATALOGUE_UNAVAILABLE" });
    await expect(engineOfPairLive({ featureSlug: "x", legKey: "y" })).rejects.toMatchObject({ status: 502 });
  });
});
