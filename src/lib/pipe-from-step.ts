/**
 * The step a pipe starts FROM (PIPE-FROM-STEP-1024): what a message written for a person consumes.
 *
 * Doctrine (agent-config skill `cost-accounting`, owner 2026-10-24): a run consumes the occurrence
 * its PIPE starts from, the leg's `from` step: `lead_found` for a pipe from Lead found, the reply /
 * form / signup / meeting occurrence for a reactive pipe; never an invented `lead_found` for a person
 * who was never served (5,295 such consumptions read "unknown provenance" on runs-service's
 * reconciliation: AI meeting booking, follow-up and cold WhatsApp messages to people who replied or
 * filled a form and were never served).
 *
 * The pipe = the campaign's (featureSlug = channel slug, legKey), read from campaign-service (a
 * campaign is one pipe). Its `from` step is features-service's catalogue (`GET /public/channels`:
 * `channels[].stepTransitions[]` `{legKey, from}`; a legacy outbound spelling `start_to_*` resolves
 * through `legKeyCorrespondence`). The leg key is OPAQUE: never split, never a slug list.
 * A pipe from nothing (Start: sourcing, a reactive pipe on a reported condition) consumes no lead
 * occurrence.
 */

import { getCampaignPipe, type CampaignPipe, type ServiceIdentity } from "./campaign-client.js";

export interface CataloguePipe {
  featureSlug: string;
  legKey: string;
}

/** The slice of `GET /public/channels` this module reads. */
export interface ChannelCatalogue {
  channels: Array<{
    slug: string;
    channelType?: string | null;
    stepTransitions: Array<{ legKey: string; from: { key: string } | null }>;
  }>;
  legKeyCorrespondence?: Array<{ channelType: string; legacyLegKey: string; legKey: string }>;
}

export type PipeFromStep =
  | { known: true; fromStep: string | null }
  | { known: false; reason: "no_campaign" | "campaign_states_no_leg" | "campaign_unreadable" | "catalogue_unreadable" | "pipe_not_in_catalogue" };

/** Pure: the `from` step of (featureSlug, legKey) on the catalogue. */
export function fromStepOnCatalogue(catalogue: ChannelCatalogue, pipe: CataloguePipe): PipeFromStep {
  const channel = catalogue.channels.find((c) => c.slug === pipe.featureSlug);
  if (!channel) return { known: false, reason: "pipe_not_in_catalogue" };
  const direct = channel.stepTransitions.find((t) => t.legKey === pipe.legKey);
  if (direct) return { known: true, fromStep: direct.from?.key ?? null };
  const renamed = (catalogue.legKeyCorrespondence ?? []).find(
    (c) => c.legacyLegKey === pipe.legKey && c.channelType === channel.channelType,
  );
  const viaRename = renamed ? channel.stepTransitions.find((t) => t.legKey === renamed.legKey) : undefined;
  if (viaRename) return { known: true, fromStep: viaRename.from?.key ?? null };
  return { known: false, reason: "pipe_not_in_catalogue" };
}

const FEATURES_SERVICE_URL = () => process.env.FEATURES_SERVICE_URL || "http://localhost:3050";
export const CATALOGUE_CACHE_MS = 5 * 60_000;
let cached: { catalogue: ChannelCatalogue; at: number } | null = null;
let inFlight: Promise<ChannelCatalogue> | null = null;

/** features-service's channel catalogue, held 5 min (it changes when staff publish a pipe). Throws when unreadable. */
export async function fetchChannelCatalogue(): Promise<ChannelCatalogue> {
  if (cached && Date.now() - cached.at < CATALOGUE_CACHE_MS) return cached.catalogue;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(`${FEATURES_SERVICE_URL()}/public/channels`, {
        headers: { "X-Api-Key": process.env.FEATURES_SERVICE_API_KEY || "" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`features-service GET /public/channels failed: ${res.status}`);
      const body = (await res.json()) as ChannelCatalogue;
      if (!Array.isArray(body?.channels)) throw new Error("features-service GET /public/channels: no channels[]");
      cached = { catalogue: body, at: Date.now() };
      return body;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Exposed for tests. */
export function clearChannelCatalogueCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * The `from` step of a campaign's pipe, never throwing: an unknown pipe is `known: false` with its
 * reason (the caller then consumes no lead occurrence and logs it: a missing input under-counts,
 * an invented one breaks the ledger).
 */
export async function resolvePipeFromStep(pipe: CampaignPipe): Promise<PipeFromStep> {
  if (!pipe) return { known: false, reason: "no_campaign" };
  if ("error" in pipe) return { known: false, reason: pipe.error };
  let catalogue: ChannelCatalogue;
  try {
    catalogue = await fetchChannelCatalogue();
  } catch (err) {
    console.error("[content-gen] channel catalogue unreadable: the message consumes no lead occurrence", err instanceof Error ? err.message : err);
    return { known: false, reason: "catalogue_unreadable" };
  }
  return fromStepOnCatalogue(catalogue, pipe);
}

/** The `from` step of the pipe a message is written for: the run's campaign, then the catalogue. */
export async function messageFromStep(campaignId: string | null | undefined, identity: ServiceIdentity): Promise<PipeFromStep> {
  const result = await resolvePipeFromStep(await getCampaignPipe(campaignId, identity));
  if (!result.known) console.warn(`[content-gen] pipe of campaign ${campaignId ?? "none"} unknown (${result.reason}): the message consumes no lead occurrence`);
  return result;
}
