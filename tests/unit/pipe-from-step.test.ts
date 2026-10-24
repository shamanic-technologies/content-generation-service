import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type * as PipeFromStep from "../../src/lib/pipe-from-step.js";
import { clearCampaignCache } from "../../src/lib/campaign-client.js";

// PIPE-FROM-STEP-1024: the real module (tests/setup.ts stubs messageFromStep for the other suites).
const { fromStepOnCatalogue, messageFromStep, clearChannelCatalogueCache } =
  await vi.importActual<typeof PipeFromStep>("../../src/lib/pipe-from-step.js");

const catalogue = {
  channels: [
    { slug: "sales-cold-email-outreach", channelType: "outbound", stepTransitions: [{ legKey: "lead_found_to_conversation", from: { key: "lead_found" } }] },
    { slug: "ai-meeting-booking", channelType: "inbound", stepTransitions: [
      { legKey: "conversation_to_meeting_booked", from: { key: "conversation" } },
      { legKey: "form_submitted_to_meeting_booked", from: { key: "form_submitted" } },
    ] },
    { slug: "cold-whatsapp-outreach", channelType: "outbound", stepTransitions: [{ legKey: "start_to_signup", from: null }] },
  ],
  legKeyCorrespondence: [{ channelType: "outbound", legacyLegKey: "start_to_conversation", legKey: "lead_found_to_conversation" }],
};

describe("fromStepOnCatalogue", () => {
  it("a pipe from Lead found consumes lead_found; a reactive pipe its own from step", () => {
    expect(fromStepOnCatalogue(catalogue, { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" })).toEqual({ known: true, fromStep: "lead_found" });
    expect(fromStepOnCatalogue(catalogue, { featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked" })).toEqual({ known: true, fromStep: "conversation" });
    expect(fromStepOnCatalogue(catalogue, { featureSlug: "ai-meeting-booking", legKey: "form_submitted_to_meeting_booked" })).toEqual({ known: true, fromStep: "form_submitted" });
  });

  it("a pipe from nothing has no from step", () => {
    expect(fromStepOnCatalogue(catalogue, { featureSlug: "cold-whatsapp-outreach", legKey: "start_to_signup" })).toEqual({ known: true, fromStep: null });
  });

  it("a legacy outbound spelling resolves through the catalogue's correspondence", () => {
    expect(fromStepOnCatalogue(catalogue, { featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" })).toEqual({ known: true, fromStep: "lead_found" });
  });

  it("a pipe the catalogue does not publish is unknown, never guessed from the key", () => {
    expect(fromStepOnCatalogue(catalogue, { featureSlug: "ai-meeting-booking", legKey: "lead_found_to_conversation" })).toEqual({ known: false, reason: "pipe_not_in_catalogue" });
    expect(fromStepOnCatalogue(catalogue, { featureSlug: "nope", legKey: "conversation_to_meeting_booked" })).toEqual({ known: false, reason: "pipe_not_in_catalogue" });
  });
});

describe("messageFromStep", () => {
  beforeEach(() => {
    clearChannelCatalogueCache();
    clearCampaignCache();
  });
  afterEach(() => vi.unstubAllGlobals());
  const identity = { orgId: "org-1", userId: "u" };

  const stub = (campaign: unknown, catalogueStatus = 200) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/campaigns/")) return campaign ? new Response(JSON.stringify({ campaign }), { status: 200 }) : new Response("{}", { status: 404 });
      if (url.includes("/public/channels")) return new Response(JSON.stringify(catalogue), { status: catalogueStatus });
      throw new Error(`unexpected ${url}`);
    }));

  it("reads the campaign's pipe, then its from step on the catalogue", async () => {
    stub({ id: "c1", orgId: "org-1", brandId: null, featureSlug: "ai-meeting-booking", featureInputs: null, legKey: "conversation_to_meeting_booked" });
    expect(await messageFromStep("c1", identity)).toEqual({ known: true, fromStep: "conversation" });
  });

  it("no campaign, a campaign stating no leg, an unreadable campaign or catalogue: unknown, never throws", async () => {
    stub(null);
    expect(await messageFromStep(undefined, identity)).toEqual({ known: false, reason: "no_campaign" });
    expect(await messageFromStep("gone", identity)).toEqual({ known: false, reason: "campaign_unreadable" });
    clearCampaignCache();
    stub({ id: "c2", orgId: "org-1", brandId: null, featureSlug: "sales-cold-email-outreach", featureInputs: null, legKey: null });
    expect(await messageFromStep("c2", identity)).toEqual({ known: false, reason: "campaign_states_no_leg" });
    clearCampaignCache();
    stub({ id: "c3", orgId: "org-1", brandId: null, featureSlug: "ai-meeting-booking", featureInputs: null, legKey: "conversation_to_meeting_booked" }, 503);
    expect(await messageFromStep("c3", identity)).toEqual({ known: false, reason: "catalogue_unreadable" });
  });
});
