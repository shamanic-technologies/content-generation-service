/**
 * Reads, at request time, who writes the signed-out preview (PREVIEW-EMAIL-503-1111, SCRIPT-VALUE-RATING-1113): the
 * `message_written` scripts the strategy keeps (features-service, no campaign) and workflow-service's Rating pick among
 * them; the cold email script the Rating picks in the Engine the catalogue states on the cold email pipe, among the
 * kept ones that write through `message_written`, and the template + LLM its tactics state for its writing call; then
 * the stated template dynasty's head. The I/O half of `preview-writer.ts` (which holds the rules and is never mocked).
 *
 * Both picks are cached a few minutes per strategy (a visitor asking for three emails does not re-read the strategy
 * three times); the dynasty head is read per preview. Any failure is LOUD (`PreviewWriterError`): there is no
 * fallback script, template or model.
 */
import { fetchChannelCatalogue } from "./pipe-from-step.js";
import { resolveDynastyHead } from "./template-dynasty-query.js";
import { TemplateDynastyError } from "./template-dynasties.js";
import { buildTrackingHeaders, type Tracking } from "./tracking.js";
import {
  PREVIEW_ENGINE_OUTCOME,
  PREVIEW_WRITER_MATERIALS,
  PreviewWriterError,
  keptScripts,
  writerEngineOnCatalogue,
  writerFromTactics,
  writingScriptsOf,
  type EngineScriptRow,
  type PreviewScript,
  type PreviewWriterPlan,
  type ScriptStrategyAnswer,
} from "./preview-writer.js";

const FEATURES_SERVICE_URL = process.env.FEATURES_SERVICE_URL || "http://localhost:3050";
const FEATURES_SERVICE_API_KEY = process.env.FEATURES_SERVICE_API_KEY || "";
const WORKFLOW_SERVICE_URL = process.env.WORKFLOW_SERVICE_URL || "http://localhost:3040";
const WORKFLOW_SERVICE_API_KEY = process.env.WORKFLOW_SERVICE_API_KEY || "";

export const PREVIEW_WRITER_CACHE_MS = 5 * 60_000;

/** What the Rating picked (both scripts, the cold email one's writer), keyed by strategy id ("" = no strategy). */
type PickedWriter = Omit<PreviewWriterPlan, "promptType">;
const cached = new Map<string, { picked: PickedWriter; at: number }>();

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

/** The scripts the strategy keeps for an Engine, with no campaign. An unknown strategy = 400 UNKNOWN_STRATEGY. */
async function readScriptStrategy(outcome: string, strategyId?: string): Promise<ScriptStrategyAnswer> {
  const res = await featuresGet(
    `/internal/script-strategy?outcome=${encodeURIComponent(outcome)}${strategyId ? `&strategyId=${encodeURIComponent(strategyId)}` : ""}`,
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
 * The Engine whose cold email script is picked: the one features-service's channel catalogue states on the cold email
 * pipe (catalogue held 5 min, `fetchChannelCatalogue`). Unreadable = 502, never a hand-typed Engine.
 */
async function coldEmailEngine(): Promise<string> {
  let catalogue;
  try {
    catalogue = await fetchChannelCatalogue();
  } catch (err) {
    throw new PreviewWriterError(502, `features-service channel catalogue unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return writerEngineOnCatalogue(catalogue);
}

/** The Engine's live script versions with their tactics (workflow-service `GET /scripts?outcome=`, a read under the caller's identity). */
async function readEngineScripts(outcome: string, identity: Tracking): Promise<EngineScriptRow[]> {
  let res: Response;
  try {
    res = await fetch(`${WORKFLOW_SERVICE_URL}/scripts?outcome=${encodeURIComponent(outcome)}`, {
      headers: { "X-Api-Key": WORKFLOW_SERVICE_API_KEY, ...buildTrackingHeaders(identity) },
    });
  } catch (err) {
    throw new PreviewWriterError(502, `workflow-service scripts of ${outcome} unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new PreviewWriterError(502, `workflow-service scripts of ${outcome} failed: ${res.status} - ${await res.text()}`);
  }
  const body = (await res.json()) as { scripts?: unknown };
  if (!Array.isArray(body.scripts)) {
    throw new PreviewWriterError(502, `workflow-service answered no scripts list for ${outcome}`);
  }
  return body.scripts as EngineScriptRow[];
}

/** workflow-service's Rating pick (`POST /internal/engines/{outcome}/pick`, the run's own `pickScript`), as the preview reads it. */
interface RatingPickAnswer extends PreviewScript {
  tactics: Record<string, unknown> | null;
}

/**
 * workflow-service's Rating picks among the kept dynasties, exactly as a campaign run does (`POST
 * /internal/engines/{outcome}/pick`, PREVIEW-RATING-PICK-1111): the choice is never made here. Nothing it can run on
 * what the preview hands = 422 NO_SCRIPT_KEPT.
 */
async function ratingPick(outcome: string, keptDynasties: string[], servable: readonly string[]): Promise<RatingPickAnswer> {
  let res: Response;
  try {
    res = await fetch(`${WORKFLOW_SERVICE_URL}/internal/engines/${encodeURIComponent(outcome)}/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": WORKFLOW_SERVICE_API_KEY },
      body: JSON.stringify({ keptDynasties, servable: [...servable] }),
    });
  } catch (err) {
    throw new PreviewWriterError(502, `workflow-service Rating pick unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) {
    throw new PreviewWriterError(422, `workflow-service's Rating finds no script of the ${outcome} Engine it can run for a preview among ${keptDynasties.join(", ")}: ${await res.text()}`, "NO_SCRIPT_KEPT");
  }
  if (!res.ok) {
    throw new PreviewWriterError(502, `workflow-service Rating pick for ${outcome} failed: ${res.status} - ${await res.text()}`);
  }
  const body = (await res.json()) as { dynasty?: unknown; version?: unknown; tactics?: unknown };
  if (typeof body.dynasty !== "string" || typeof body.version !== "number") {
    throw new PreviewWriterError(502, `workflow-service Rating pick for ${outcome} answered without dynasty and version`);
  }
  const tactics = body.tactics === null || (typeof body.tactics === "object" && !Array.isArray(body.tactics)) ? (body.tactics as Record<string, unknown> | null) : undefined;
  if (tactics === undefined) {
    throw new PreviewWriterError(502, `workflow-service Rating pick for ${outcome} answered without the picked script's tactics`);
  }
  return { dynasty: body.dynasty, version: body.version, tactics };
}

/** The `message_written` script the strategy keeps, as the Rating picks it on the preview's materials. */
async function previewScript(strategyId?: string): Promise<PreviewScript> {
  const strategy = await readScriptStrategy(PREVIEW_ENGINE_OUTCOME, strategyId);
  const { dynasty, version } = await ratingPick(PREVIEW_ENGINE_OUTCOME, keptScripts(strategy, strategyId).map((s) => s.dynasty), PREVIEW_WRITER_MATERIALS);
  return { dynasty, version };
}

/**
 * The cold email script the Rating picks (Engine stated by the catalogue on the cold email pipe, kept by the strategy,
 * writing through `message_written`) and the template + LLM its tactics state for its writing call. The preview hands
 * it nothing: it asks its writer itself (tactic `asks`), which is the preview's own run.
 */
async function coldEmailWriter(identity: Tracking, strategyId?: string): Promise<Pick<PreviewWriterPlan, "emailScript" | "templateDynastySlug" | "model">> {
  const engine = await coldEmailEngine();
  const [strategy, rows] = await Promise.all([readScriptStrategy(engine, strategyId), readEngineScripts(engine, identity)]);
  const writing = writingScriptsOf(rows, strategy.keptDynasties, engine, strategyId);
  const picked = await ratingPick(engine, writing, []);
  const script = { dynasty: picked.dynasty, version: picked.version };
  return { emailScript: { ...script, engine }, ...writerFromTactics(picked.tactics, script, engine) };
}

/**
 * The `message_written` script and the cold email script the Rating picks (cached a few minutes per strategy; none =
 * no condition), with the template (stated dynasty's head) + LLM that cold email script states for its writing call.
 */
export async function resolvePreviewWriter(identity: Tracking, strategyId?: string): Promise<PreviewWriterPlan> {
  const cacheKey = strategyId ?? "";
  const hit = cached.get(cacheKey);
  let picked: PickedWriter;
  if (hit && Date.now() - hit.at < PREVIEW_WRITER_CACHE_MS) {
    picked = hit.picked;
  } else {
    const [script, writer] = await Promise.all([previewScript(strategyId), coldEmailWriter(identity, strategyId)]);
    picked = { script, ...writer };
    cached.set(cacheKey, { picked, at: Date.now() });
  }
  let promptType: string;
  try {
    promptType = (await resolveDynastyHead(picked.templateDynastySlug)).template.type;
  } catch (err) {
    if (err instanceof TemplateDynastyError) {
      throw new PreviewWriterError(503, `The cold email script ${picked.emailScript.engine}/${picked.emailScript.dynasty} v${picked.emailScript.version} states template dynasty ${picked.templateDynastySlug}, which has no template to write with here: ${err.message}`, "WRITER_PICK_UNAVAILABLE");
    }
    throw err;
  }
  const plan: PreviewWriterPlan = { ...picked, promptType };
  console.log(`[content-generation-service] preview writer${strategyId ? ` for strategy ${strategyId}` : ""} (run ${identity.runId}): script=${plan.script.dynasty} v${plan.script.version}, cold email script=${plan.emailScript.engine}/${plan.emailScript.dynasty} v${plan.emailScript.version}, template=${plan.templateDynastySlug} (${promptType}), model=${plan.model}`);
  return plan;
}
