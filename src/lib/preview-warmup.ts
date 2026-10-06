/**
 * Warms the brand intel a signed-out preview email needs, ahead of the preview itself.
 *
 * The first `POST /preview-email` for a brand used to spend most of its time in
 * brand-service extract-fields (map the whole site, scrape pages, run an LLM: 125 s of
 * 137 s measured in prod 2026-10-06), because the best mature workflow's own field set
 * was never cached yet. The onboarding knows the brand long before it asks for the
 * preview, so it calls `POST /preview-email/prepare` early and this module sends brand-
 * service the SAME request the preview will send. brand-service caches each field per
 * (brand, field key, description hash, campaign) for days, not per offer, so the
 * preview's later read (offer named or not) is then answered from that cache.
 *
 * Same spend, moved earlier: the warm-up's brand-service call is the one the preview
 * would otherwise make, billed by brand-service to the calling org from the identity
 * headers of the request that asked for it. Nothing else is called or billed.
 *
 * In-process, deliberately: the work runs after the caller is answered, and at most one
 * warm-up per (org, brand) is in flight. A preview that arrives while one is in flight
 * waits for it instead of starting a second site read. A restart drops an in-flight
 * warm-up; the preview then pays the read itself, as it did before this existed.
 */
import { fetchBrandIntel, type ServiceIdentity } from "./brand-client.js";
import { resolvePreviewWorkflow } from "./preview-workflow-client.js";
import { previewBrandIntelFields } from "./preview-email.js";

/** A completed warm-up answers repeats as `ready` without re-asking brand-service for this long. */
export const PREVIEW_WARMUP_READY_MS = 10 * 60_000;

export type PreviewWarmupStatus = "started" | "in_progress" | "ready";

const inFlight = new Map<string, Promise<void>>();
const readyAt = new Map<string, number>();

function warmupKey(orgId: string, brandId: string): string {
  return `${orgId}:${brandId}`;
}

/** Test seam. */
export function __resetPreviewWarmups(): void {
  inFlight.clear();
  readyAt.clear();
}

/**
 * Starts warming the preview's brand intel for `identity.brandId` in the background and
 * says where it stands. Never waits for the work: the caller is a browser that must not
 * hold a request open for the length of a site read.
 */
export function startPreviewWarmup(identity: ServiceIdentity & { orgId: string; brandId: string }): PreviewWarmupStatus {
  const key = warmupKey(identity.orgId, identity.brandId);
  if (inFlight.has(key)) return "in_progress";
  const at = readyAt.get(key);
  if (at !== undefined && Date.now() - at < PREVIEW_WARMUP_READY_MS) return "ready";

  const startedAt = Date.now();
  const work = (async () => {
    const plan = await resolvePreviewWorkflow(identity);
    const intel = await fetchBrandIntel(previewBrandIntelFields(plan), identity);
    const fields = Object.values(intel.fields ?? {});
    const fromCache = fields.filter((f) => Object.values(f.byBrand ?? {}).every((b) => b.cached)).length;
    readyAt.set(key, Date.now());
    console.log(`[content-generation-service] preview warm-up done brandId=${identity.brandId} org=${identity.orgId} run=${identity.runId} workflow=${plan.workflowSlug} fields=${fields.length} alreadyCached=${fromCache} ms=${Date.now() - startedAt}`);
  })()
    .catch((err) => {
      // Nobody is waiting on this answer: say it loudly here. The preview, when it comes,
      // makes the same read itself and answers the caller with brand-service's verdict.
      console.error(`[content-generation-service] preview warm-up FAILED brandId=${identity.brandId} org=${identity.orgId} run=${identity.runId} ms=${Date.now() - startedAt}:`, err instanceof Error ? err.message : err);
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, work);
  return "started";
}

/**
 * Resolves once any warm-up in flight for this (org, brand) has settled, so the preview
 * reads brand-service's cache instead of starting a second site read beside it. Resolves
 * immediately when none is in flight. Never rejects: a failed warm-up was already logged,
 * and the preview's own read reports brand-service's verdict to its caller.
 */
export function awaitPreviewWarmup(orgId: string, brandId: string): Promise<void> {
  return inFlight.get(warmupKey(orgId, brandId)) ?? Promise.resolve();
}
