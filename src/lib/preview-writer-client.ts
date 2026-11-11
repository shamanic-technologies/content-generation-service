/**
 * Reads, at request time, who writes the signed-out preview (PREVIEW-EMAIL-503-1111): the scripts the strategy keeps
 * for the email Engine (features-service, no campaign), the template + LLM features-service picks for cold email, the
 * picked template dynasty's head. The I/O half of `preview-writer.ts` (which holds the rules and is never mocked).
 *
 * Cached in memory a few minutes per strategy: features-service rebuilds its rankings every 15 minutes, so a visitor
 * asking for three emails does not re-read them three times. Any failure is LOUD (`PreviewWriterError`): there is no
 * fallback script, template or model.
 */
import { resolveDynastyHead } from "./template-dynasty-query.js";
import { TemplateDynastyError } from "./template-dynasties.js";
import {
  PREVIEW_ENGINE_OUTCOME,
  PreviewWriterError,
  WRITER_RANKING_FEATURE_SLUG,
  WRITER_RANKING_LEG,
  keptScripts,
  writerFromRanking,
  type PreviewWriterPlan,
  type ScriptStrategyAnswer,
  type WriterRanking,
} from "./preview-writer.js";

const FEATURES_SERVICE_URL = process.env.FEATURES_SERVICE_URL || "http://localhost:3050";
const FEATURES_SERVICE_API_KEY = process.env.FEATURES_SERVICE_API_KEY || "";

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
 * The script, template and LLM that write the preview (per strategy; none = no condition). Several kept scripts are
 * the Rating's to choose between: until workflow-service answers that choice outside a run, the preview refuses by
 * name rather than pick one itself.
 */
export async function resolvePreviewWriter(strategyId?: string): Promise<PreviewWriterPlan> {
  const cacheKey = strategyId ?? "";
  const hit = cached.get(cacheKey);
  if (hit && Date.now() - hit.at < PREVIEW_WRITER_CACHE_MS) return hit.plan;

  const [strategy, ranking] = await Promise.all([readScriptStrategy(strategyId), readWriterRanking(strategyId)]);
  const scripts = keptScripts(strategy, strategyId);
  if (scripts.length > 1) {
    throw new PreviewWriterError(
      503,
      `The email Engine keeps ${scripts.length} scripts (${scripts.map((s) => s.dynasty).join(", ")}); workflow-service's Rating chooses among them and cannot be asked outside a campaign run yet, so no preview can be written`,
      "SCRIPT_PICK_UNAVAILABLE",
    );
  }
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
  const plan: PreviewWriterPlan = { script: scripts[0], templateDynastySlug: pick.templateDynastySlug, promptType, model: pick.model };
  console.log(`[content-generation-service] preview writer${strategyId ? ` for strategy ${strategyId}` : ""}: script=${plan.script.dynasty} v${plan.script.version}, template=${pick.templateDynastySlug} (${promptType}), model=${plan.model}`);
  cached.set(cacheKey, { plan, at: Date.now() });
  return plan;
}
