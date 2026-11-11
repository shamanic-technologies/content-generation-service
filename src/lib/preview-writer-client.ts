/**
 * Reads, at request time, who writes the signed-out preview (PREVIEW-EMAIL-503-1111): the scripts the strategy keeps
 * for the email Engine (features-service, no campaign), the template + LLM features-service picks for cold email, the
 * picked template dynasty's head, and workflow-service's Rating pick among the kept scripts. The I/O half of `preview-writer.ts` (which holds the rules and is never mocked).
 *
 * Cached in memory a few minutes per strategy: features-service rebuilds its rankings every 15 minutes, so a visitor
 * asking for three emails does not re-read them three times. Any failure is LOUD (`PreviewWriterError`): there is no
 * fallback script, template or model.
 */
import { resolveDynastyHead } from "./template-dynasty-query.js";
import { TemplateDynastyError } from "./template-dynasties.js";
import {
  PREVIEW_ENGINE_OUTCOME,
  PREVIEW_WRITER_MATERIALS,
  PreviewWriterError,
  WRITER_RANKING_FEATURE_SLUG,
  WRITER_RANKING_LEG,
  keptScripts,
  writerFromRanking,
  type PreviewScript,
  type PreviewWriterPlan,
  type ScriptStrategyAnswer,
  type WriterRanking,
} from "./preview-writer.js";

const FEATURES_SERVICE_URL = process.env.FEATURES_SERVICE_URL || "http://localhost:3050";
const FEATURES_SERVICE_API_KEY = process.env.FEATURES_SERVICE_API_KEY || "";
const WORKFLOW_SERVICE_URL = process.env.WORKFLOW_SERVICE_URL || "http://localhost:3040";
const WORKFLOW_SERVICE_API_KEY = process.env.WORKFLOW_SERVICE_API_KEY || "";

export const PREVIEW_WRITER_CACHE_MS = 5 * 60_000;

/** Keyed by strategy id ("" = no strategy). */
const cached = new Map<string, { plan: PreviewWriterPlan; at: number }>();

/** Test seam. */
export function __resetPreviewWriterCache(): void {
  cached.clear();
}

async function featuresGet(path: string, what: string): Promise<Response> {
  try {
    return await fetch(`${FEATURES_SERVICE_URL}${path}`, { headers: { "X-Api-Key": FEATURES_SERVICE_API_KEY } });
  } catch (err) {
    throw new PreviewWriterError(502, `features-service ${what} unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The scripts the strategy keeps for the email Engine, with no campaign. An unknown strategy = 400 UNKNOWN_STRATEGY. */
async function readScriptStrategy(strategyId?: string): Promise<ScriptStrategyAnswer> {
  const res = await featuresGet(
    `/internal/script-strategy?outcome=${encodeURIComponent(PREVIEW_ENGINE_OUTCOME)}${strategyId ? `&strategyId=${encodeURIComponent(strategyId)}` : ""}`,
    "script-strategy",
  );
  if (res.status === 404 && strategyId) {
    throw new PreviewWriterError(400, `strategyId: features-service knows no strategy "${strategyId}": ${await res.text()}`, "UNKNOWN_STRATEGY");
  }
  if (!res.ok) {
    throw new PreviewWriterError(502, `features-service script-strategy failed: ${res.status} - ${await res.text()}`);
  }
  const body = (await res.json()) as Partial<ScriptStrategyAnswer>;
  if (!Array.isArray(body.keptDynasties) || !Array.isArray(body.scripts)) {
    throw new PreviewWriterError(502, "features-service script-strategy answered without keptDynasties or scripts");
  }
  return { strategyId: body.strategyId ?? null, keptDynasties: body.keptDynasties, scripts: body.scripts };
}

/** features-service's template + LLM ranking for cold email, narrowed by the strategy when there is one. */
async function readWriterRanking(strategyId?: string): Promise<WriterRanking> {
  const res = await featuresGet(
    `/public/stats/leg-writer-ranking?featureSlug=${encodeURIComponent(WRITER_RANKING_FEATURE_SLUG)}&leg=${encodeURIComponent(WRITER_RANKING_LEG)}${strategyId ? `&strategyId=${encodeURIComponent(strategyId)}` : ""}`,
    "leg-writer-ranking",
  );
  if (res.status === 503) {
    throw new PreviewWriterError(503, `features-service is still computing which template and LLM write cold emails: ${await res.text()}`, "WRITER_PICK_UNAVAILABLE");
  }
  if (!res.ok) {
    throw new PreviewWriterError(502, `features-service leg-writer-ranking failed: ${res.status} - ${await res.text()}`);
  }
  const body = (await res.json()) as Partial<WriterRanking>;
  if (!body.templates || !body.llms) {
    throw new PreviewWriterError(502, "features-service leg-writer-ranking answered without templates or llms");
  }
  return { computedAt: body.computedAt ?? null, templates: body.templates, llms: body.llms };
}

/**
 * workflow-service's Rating picks among the kept dynasties, exactly as a campaign run does (`POST
 * /internal/engines/{outcome}/pick`, the run's own `pickScript`, PREVIEW-RATING-PICK-1111): one kept or several, the
 * choice is never made here. Nothing it can run on the preview's materials = 422 NO_SCRIPT_KEPT.
 */
async function ratingPick(keptDynasties: string[]): Promise<PreviewScript> {
  let res: Response;
  try {
    res = await fetch(`${WORKFLOW_SERVICE_URL}/internal/engines/${encodeURIComponent(PREVIEW_ENGINE_OUTCOME)}/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": WORKFLOW_SERVICE_API_KEY },
      body: JSON.stringify({ keptDynasties, servable: [...PREVIEW_WRITER_MATERIALS] }),
    });
  } catch (err) {
    throw new PreviewWriterError(502, `workflow-service Rating pick unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) {
    throw new PreviewWriterError(422, `workflow-service's Rating finds no script of the email Engine it can run on a preview's materials among ${keptDynasties.join(", ")}: ${await res.text()}`, "NO_SCRIPT_KEPT");
  }
  if (!res.ok) {
    throw new PreviewWriterError(502, `workflow-service Rating pick failed: ${res.status} - ${await res.text()}`);
  }
  const body = (await res.json()) as { dynasty?: unknown; version?: unknown };
  if (typeof body.dynasty !== "string" || typeof body.version !== "number") {
    throw new PreviewWriterError(502, "workflow-service Rating pick answered without dynasty and version");
  }
  return { dynasty: body.dynasty, version: body.version };
}

/** The script (the Rating's pick among the kept ones), template and LLM that write the preview (per strategy; none = no condition). */
export async function resolvePreviewWriter(strategyId?: string): Promise<PreviewWriterPlan> {
  const cacheKey = strategyId ?? "";
  const hit = cached.get(cacheKey);
  if (hit && Date.now() - hit.at < PREVIEW_WRITER_CACHE_MS) return hit.plan;

  const [strategy, ranking] = await Promise.all([readScriptStrategy(strategyId), readWriterRanking(strategyId)]);
  const script = await ratingPick(keptScripts(strategy, strategyId).map((s) => s.dynasty));
  const pick = writerFromRanking(ranking, strategyId);
  let promptType: string;
  try {
    promptType = (await resolveDynastyHead(pick.templateDynastySlug)).template.type;
  } catch (err) {
    if (err instanceof TemplateDynastyError) {
      throw new PreviewWriterError(503, `features-service picked template dynasty ${pick.templateDynastySlug}, which has no template to write with here: ${err.message}`, "WRITER_PICK_UNAVAILABLE");
    }
    throw err;
  }
  const plan: PreviewWriterPlan = { script, templateDynastySlug: pick.templateDynastySlug, promptType, model: pick.model };
  console.log(`[content-generation-service] preview writer${strategyId ? ` for strategy ${strategyId}` : ""}: script=${plan.script.dynasty} v${plan.script.version}, template=${pick.templateDynastySlug} (${promptType}), model=${plan.model}`);
  cached.set(cacheKey, { plan, at: Date.now() });
  return plan;
}
