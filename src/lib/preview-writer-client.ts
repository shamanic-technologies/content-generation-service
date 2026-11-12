/**
 * Reads, at request time, who writes the signed-out preview (PREVIEW-EMAIL-503-1111): the scripts the strategy keeps
 * for the email Engine (features-service, no campaign), workflow-service's Rating pick among them, and the template +
 * LLM the GTM Factory Rating picks for that Engine's writing call (features-service `/internal/template-pick` +
 * `/internal/llm-pick`, LLM-RATING-PER-ENGINE-1112), then the picked template dynasty's head. The I/O half of
 * `preview-writer.ts` (which holds the rules and is never mocked).
 *
 * The SCRIPT half is cached a few minutes per strategy (a visitor asking for three emails does not re-read the
 * strategy three times). The template + LLM picks are asked on EVERY preview with its run as `x-run-id`: each pick is
 * a recorded decision of that run. Any failure is LOUD (`PreviewWriterError`): there is no fallback script, template
 * or model.
 */
import { fetchChannelCatalogue } from "./pipe-from-step.js";
import { resolveDynastyHead } from "./template-dynasty-query.js";
import { TemplateDynastyError } from "./template-dynasties.js";
import {
  PREVIEW_ENGINE_OUTCOME,
  PREVIEW_WRITER_MATERIALS,
  PREVIEW_WRITER_PLACE,
  PreviewWriterError,
  keptScripts,
  writerEngineOnCatalogue,
  writerFromPicks,
  type LlmPickAnswer,
  type PreviewScript,
  type PreviewWriterPlan,
  type ScriptStrategyAnswer,
  type TemplatePickAnswer,
} from "./preview-writer.js";

const FEATURES_SERVICE_URL = process.env.FEATURES_SERVICE_URL || "http://localhost:3050";
const FEATURES_SERVICE_API_KEY = process.env.FEATURES_SERVICE_API_KEY || "";
const WORKFLOW_SERVICE_URL = process.env.WORKFLOW_SERVICE_URL || "http://localhost:3040";
const WORKFLOW_SERVICE_API_KEY = process.env.WORKFLOW_SERVICE_API_KEY || "";

export const PREVIEW_WRITER_CACHE_MS = 5 * 60_000;

/** The script the Rating picked, keyed by strategy id ("" = no strategy). */
const cached = new Map<string, { script: PreviewScript; at: number }>();

/** Test seam. */
export function __resetPreviewWriterCache(): void {
  cached.clear();
}

async function featuresGet(path: string, what: string, runId?: string): Promise<Response> {
  try {
    return await fetch(`${FEATURES_SERVICE_URL}${path}`, { headers: { "X-Api-Key": FEATURES_SERVICE_API_KEY, ...(runId ? { "x-run-id": runId } : {}) } });
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

/**
 * The Engine the preview's template + LLM picks are asked for: the one features-service's channel catalogue states on
 * the cold email pipe (catalogue held 5 min, `fetchChannelCatalogue`). Unreadable = 502, never a hand-typed Engine.
 */
async function writerEngine(): Promise<string> {
  let catalogue;
  try {
    catalogue = await fetchChannelCatalogue();
  } catch (err) {
    throw new PreviewWriterError(502, `features-service channel catalogue unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return writerEngineOnCatalogue(catalogue);
}

/**
 * One GTM Factory Rating pick (template or LLM) for the cold email pipe's Engine's writing call, recorded on the preview's run.
 * 422 = the Engine has nothing to pick (none in its universe, or none the strategy keeps): a named refusal, nothing is
 * written. 404 = the strategy is unknown.
 */
async function ratingWriterPick<T>(kind: "template" | "llm", engine: string, runId: string, strategyId?: string): Promise<T> {
  const query = new URLSearchParams({ outcome: engine, place: PREVIEW_WRITER_PLACE });
  if (strategyId) query.set("strategyId", strategyId);
  const res = await featuresGet(`/internal/${kind}-pick?${query}`, `${kind}-pick`, runId);
  if (res.status === 404 && strategyId) {
    throw new PreviewWriterError(400, `strategyId: features-service knows no strategy "${strategyId}": ${await res.text()}`, "UNKNOWN_STRATEGY");
  }
  if (res.status === 422) {
    const text = await res.text();
    const code = kind === "template" ? "NO_TEMPLATE_FOR_ENGINE" : "NO_LLM_IN_ENGINE_UNIVERSE";
    throw new PreviewWriterError(422, `The Rating picks no ${kind === "template" ? "template" : "LLM"} for the ${engine} Engine's writing call${strategyId ? ` under strategy ${strategyId}` : ""}, so no preview can be written: ${text}`, code);
  }
  if (!res.ok) {
    throw new PreviewWriterError(502, `features-service ${kind}-pick failed: ${res.status} - ${await res.text()}`);
  }
  return (await res.json()) as T;
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

/** The email Engine's script the strategy keeps, as the Rating picks it (cached a few minutes per strategy). */
async function previewScript(strategyId?: string): Promise<PreviewScript> {
  const cacheKey = strategyId ?? "";
  const hit = cached.get(cacheKey);
  if (hit && Date.now() - hit.at < PREVIEW_WRITER_CACHE_MS) return hit.script;
  const strategy = await readScriptStrategy(strategyId);
  const script = await ratingPick(keptScripts(strategy, strategyId).map((s) => s.dynasty));
  cached.set(cacheKey, { script, at: Date.now() });
  return script;
}

/**
 * The script (the Rating's pick among the kept ones), template and LLM (the Rating's picks for the Engine's writing
 * call, recorded on `runId`) that write one preview (per strategy; none = no condition).
 */
export async function resolvePreviewWriter(runId: string, strategyId?: string): Promise<PreviewWriterPlan> {
  const engine = await writerEngine();
  const [script, templatePick, llmPick] = await Promise.all([
    previewScript(strategyId),
    ratingWriterPick<TemplatePickAnswer>("template", engine, runId, strategyId),
    ratingWriterPick<LlmPickAnswer>("llm", engine, runId, strategyId),
  ]);
  const pick = writerFromPicks(templatePick, llmPick, engine);
  let promptType: string;
  try {
    promptType = (await resolveDynastyHead(pick.templateDynastySlug)).template.type;
  } catch (err) {
    if (err instanceof TemplateDynastyError) {
      throw new PreviewWriterError(503, `The Rating picked template dynasty ${pick.templateDynastySlug}, which has no template to write with here: ${err.message}`, "WRITER_PICK_UNAVAILABLE");
    }
    throw err;
  }
  const plan: PreviewWriterPlan = { script, templateDynastySlug: pick.templateDynastySlug, promptType, model: pick.model };
  console.log(`[content-generation-service] preview writer${strategyId ? ` for strategy ${strategyId}` : ""} (run ${runId}): script=${plan.script.dynasty} v${plan.script.version}, template=${pick.templateDynastySlug} (${promptType}), model=${plan.model}`);
  return plan;
}
