/**
 * Reads, at request time, which workflow writes the signed-out preview: features-service's
 * fleet ranking, then the winning workflow's DAG from workflow-service, then (for a workflow
 * that picks its writer at run time) features-service's template + LLM pick for the pipe and
 * strategy and the picked template dynasty's head. The I/O half of `preview-workflow.ts`
 * (which holds the rules and is never mocked).
 *
 * Cached in memory for a short while: the ranking itself is rebuilt by features-service
 * every 15 minutes, so a 5-minute cache never serves a choice the fleet has long
 * abandoned, and a visitor asking for three emails does not re-read it three times.
 * Any failure is LOUD (`PreviewWorkflowError`): there is no fallback template or model.
 */
import { type Tracking, buildTrackingHeaders } from "./tracking.js";
import { resolveDynastyHead } from "./template-dynasty-query.js";
import { TemplateDynastyError } from "./template-dynasties.js";
import {
  PREVIEW_FEATURE_SLUG,
  PREVIEW_LEG_KEY,
  PreviewWorkflowError,
  matureCandidates,
  planPreviewWorkflow,
  playCandidates,
  previewPlayId,
  withWriter,
  writerFromRanking,
  type LegRanking,
  type LegRankingRow,
  type PreviewPlan,
  type PreviewDagPlan,
  type PreviewPlay,
  type WriterRanking,
} from "./preview-workflow.js";

const FEATURES_SERVICE_URL = process.env.FEATURES_SERVICE_URL || "http://localhost:3050";
const FEATURES_SERVICE_API_KEY = process.env.FEATURES_SERVICE_API_KEY || "";
const WORKFLOW_SERVICE_URL = process.env.WORKFLOW_SERVICE_URL || "http://localhost:3040";
const WORKFLOW_SERVICE_API_KEY = process.env.WORKFLOW_SERVICE_API_KEY || "";

export const PREVIEW_WORKFLOW_CACHE_MS = 5 * 60_000;

/** Keyed by strategy id ("" = no strategy: the best mature workflow). */
const cached = new Map<string, { plan: PreviewPlan; at: number }>();

/** Test seam. */
export function __resetPreviewWorkflowCache(): void {
  cached.clear();
}

async function readLegRanking(): Promise<LegRanking> {
  const url = `${FEATURES_SERVICE_URL}/public/stats/leg-workflow-ranking?featureSlug=${encodeURIComponent(PREVIEW_FEATURE_SLUG)}&leg=${encodeURIComponent(PREVIEW_LEG_KEY)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "X-Api-Key": FEATURES_SERVICE_API_KEY } });
  } catch (err) {
    throw new PreviewWorkflowError(502, `features-service leg-workflow-ranking unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new PreviewWorkflowError(502, `features-service leg-workflow-ranking failed: ${res.status} - ${await res.text()}`);
  }
  const body = (await res.json()) as Partial<LegRanking>;
  if (!Array.isArray(body.rows)) {
    throw new PreviewWorkflowError(502, "features-service leg-workflow-ranking answered without rows");
  }
  return { computedAt: body.computedAt ?? null, rows: body.rows };
}

/**
 * The play a strategy names on the cold-email pipe. features-service's 404 means no such
 * play on the pipe: the caller named an unknown strategy, answered 400 UNKNOWN_STRATEGY.
 */
async function readPlay(strategyId: string): Promise<PreviewPlay> {
  const id = previewPlayId(strategyId);
  const url = `${FEATURES_SERVICE_URL}/internal/catalogue/plays/${encodeURIComponent(id)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "X-Api-Key": FEATURES_SERVICE_API_KEY } });
  } catch (err) {
    throw new PreviewWorkflowError(502, `features-service play ${id} unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) {
    throw new PreviewWorkflowError(400, `strategyId: no play "${strategyId}" on the cold-email pipe (${PREVIEW_FEATURE_SLUG}|${PREVIEW_LEG_KEY})`, "UNKNOWN_STRATEGY");
  }
  if (!res.ok) {
    throw new PreviewWorkflowError(502, `features-service play ${id} failed: ${res.status} - ${await res.text()}`);
  }
  const body = (await res.json()) as Partial<PreviewPlay>;
  if (!Array.isArray(body.allowedWorkflowDynastySlugs)) {
    throw new PreviewWorkflowError(502, `features-service play ${id} answered without allowedWorkflowDynastySlugs`);
  }
  return { id, allowedWorkflowDynastySlugs: body.allowedWorkflowDynastySlugs, bestWorkflowSlug: body.bestWorkflowSlug ?? null };
}

/**
 * features-service's template + LLM ranking of the cold-email pipe, narrowed by the strategy
 * when there is one: the same ranking a run's `writer-pick` reads its best rows from.
 */
async function readWriterRanking(strategyId?: string): Promise<WriterRanking> {
  const url = `${FEATURES_SERVICE_URL}/public/stats/leg-writer-ranking?featureSlug=${encodeURIComponent(PREVIEW_FEATURE_SLUG)}&leg=${encodeURIComponent(PREVIEW_LEG_KEY)}${strategyId ? `&strategyId=${encodeURIComponent(strategyId)}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "X-Api-Key": FEATURES_SERVICE_API_KEY } });
  } catch (err) {
    throw new PreviewWorkflowError(502, `features-service leg-writer-ranking unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 503) {
    throw new PreviewWorkflowError(503, `features-service is still computing which template and LLM write cold emails: ${await res.text()}`, "WRITER_PICK_UNAVAILABLE");
  }
  if (!res.ok) {
    throw new PreviewWorkflowError(502, `features-service leg-writer-ranking failed: ${res.status} - ${await res.text()}`);
  }
  const body = (await res.json()) as Partial<WriterRanking>;
  if (!body.templates || !body.llms) {
    throw new PreviewWorkflowError(502, "features-service leg-writer-ranking answered without templates or llms");
  }
  return { computedAt: body.computedAt ?? null, templates: body.templates, llms: body.llms };
}

/**
 * The template + model a run of this workflow writes with: stated in the DAG, or picked by
 * features-service and resolved to the dynasty head exactly as the run's `template-head` does.
 */
async function resolveWriter(plan: PreviewDagPlan, strategyId?: string): Promise<PreviewPlan> {
  if (plan.writer.kind === "literal") return withWriter(plan, plan.writer.promptType, plan.writer.model);
  const pick = writerFromRanking(await readWriterRanking(strategyId), strategyId);
  let head: string;
  try {
    head = (await resolveDynastyHead(pick.templateDynastySlug)).template.type;
  } catch (err) {
    if (err instanceof TemplateDynastyError) {
      throw new PreviewWorkflowError(503, `features-service picked template dynasty ${pick.templateDynastySlug}, which has no template to write with here: ${err.message}`, "WRITER_PICK_UNAVAILABLE");
    }
    throw err;
  }
  return withWriter(plan, head, pick.model);
}

interface WorkflowRow {
  workflowSlug: string;
  workflowDynastySlug: string;
  dag: unknown;
}

/** The dynasty's EXECUTABLE version (workflow-service's default `status`), exactly one. */
async function readActiveWorkflow(dynastySlug: string, identity: Tracking): Promise<WorkflowRow> {
  const url = `${WORKFLOW_SERVICE_URL}/workflows?featureSlug=${encodeURIComponent(PREVIEW_FEATURE_SLUG)}&workflowDynastySlug=${encodeURIComponent(dynastySlug)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "X-Api-Key": WORKFLOW_SERVICE_API_KEY, ...buildTrackingHeaders(identity) } });
  } catch (err) {
    throw new PreviewWorkflowError(502, `workflow-service unreachable reading ${dynastySlug}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new PreviewWorkflowError(502, `workflow-service GET /workflows failed for ${dynastySlug}: ${res.status} - ${await res.text()}`);
  }
  const body = (await res.json()) as { workflows?: WorkflowRow[] };
  const rows = body.workflows ?? [];
  if (rows.length !== 1) {
    throw new PreviewWorkflowError(502, `workflow-service lists ${rows.length} executable versions of ${dynastySlug} (expected exactly one)`);
  }
  return rows[0];
}

/**
 * The plan of the cold-email workflow a preview writes with, whose writing it can reproduce.
 * Without `strategyId`: the best MATURE workflow (mature candidates best first). With it:
 * the workflow a campaign running that play would write with (`playCandidates`). A
 * workflow a preview cannot reproduce (see `planPreviewWorkflow`) is skipped, loudly, for
 * the next one.
 */
export async function resolvePreviewWorkflow(identity: Tracking, strategyId?: string): Promise<PreviewPlan> {
  const cacheKey = strategyId ?? "";
  const hit = cached.get(cacheKey);
  if (hit && Date.now() - hit.at < PREVIEW_WORKFLOW_CACHE_MS) return hit.plan;

  let candidates: LegRankingRow[];
  if (strategyId === undefined) {
    candidates = matureCandidates(await readLegRanking());
  } else {
    const [play, ranking] = await Promise.all([readPlay(strategyId), readLegRanking()]);
    candidates = playCandidates(ranking, play);
  }
  const skipped: string[] = [];
  for (const candidate of candidates) {
    const workflow = await readActiveWorkflow(candidate.workflowDynastySlug, identity);
    const result = planPreviewWorkflow(workflow);
    if (result.ok) {
      if (skipped.length > 0) {
        console.warn(`[content-generation-service] preview workflow: skipped ${skipped.length} better-ranked mature workflow(s): ${skipped.join(" | ")}`);
      }
      const plan = await resolveWriter(result.plan, strategyId);
      console.log(`[content-generation-service] preview workflow${strategyId ? ` for play ${strategyId}` : ""}: ${plan.workflowSlug} (rank ${candidate.rank}), writer=${result.plan.writer.kind}, type=${plan.promptType}, model=${plan.model}`);
      cached.set(cacheKey, { plan, at: Date.now() });
      return plan;
    }
    skipped.push(result.reason);
  }
  throw new PreviewWorkflowError(503, `No ${strategyId ? `cold-email workflow of play ${strategyId}` : "mature cold-email workflow"} can be reproduced by a preview: ${skipped.join(" | ")}`);
}
