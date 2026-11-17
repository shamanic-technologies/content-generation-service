/**
 * WHO WRITES THE SIGNED-OUT PREVIEW (PREVIEW-EMAIL-503-1111, ONE-WRITER-N-MODELS-1116-CG-PREVIEW).
 *
 * The preview is the first email a campaign would send, written by the SAME writer a campaign uses: no workflow, no
 * play, no leg ranking, and no model or template chosen here. A brand with zero history and no campaign always gets
 * an email.
 *
 *  - The sender: the cold email script the Rating picks in the Engine the catalogue states on the cold email pipe
 *    (`PREVIEW_WRITER_PIPE`, `writerEngineOnCatalogue`), among the scripts the strategy keeps (features-service, no
 *    campaign) that ask `message_written` (tactic `asks`, `writingScriptsOf`). The preview never runs it (it sends).
 *  - The writer: the way of writing the Rating picks for THAT sender (`message_written`, kept by the strategy, handed
 *    what a sender hands it: `generation_request`, `askedBy` the sender). Its tactic `template` = the template dynasty
 *    (its head keys the stored preview and its tokens). The preview RUNS this writer (workflow-service
 *    `POST /orgs/scripts/run`) with a `generation_request` whose body carries `preview` (our `/generate/materials`
 *    answers it with no lead); the writer asks the LLM completion Engine itself, so the Rating picks the model for
 *    THAT writer inside the run. No side pick of a model here.
 *  - The inputs: a preview has no lead. Its lead facts come from the sample recipient, the brand's from brand-service,
 *    under the variable names a sender fills (`previewVariables`). A template input nothing fills is asked of
 *    brand-service like `/generate` (Convention 1), then "" (never invented).
 *
 * Pure leaf (no I/O, never `vi.mock`'d).
 */
import { transitionOnCatalogue, type ChannelCatalogue } from "./pipe-from-step.js";
import type { PreviewRecipient } from "./preview-email.js";

/** The Engine of the writer the preview runs: the outcome its scripts make. */
export const PREVIEW_ENGINE_OUTCOME = "message_written";

/** A refusal to write the preview, carried with the status the route answers. */
export class PreviewWriterError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "PreviewWriterError";
  }
}

/** features-service's answer to "which scripts does this strategy keep for the Engine" (no campaign). */
export interface ScriptStrategyAnswer {
  strategyId: string | null;
  keptDynasties: string[];
  scripts: Array<{ dynasty: string; scriptId: string; version: number; kept: boolean; reason: string | null }>;
}

export interface PreviewScript {
  dynasty: string;
  version: number;
}

/**
 * The scripts the preview may run, as features-service kept them. Throws a named refusal when the strategy keeps none:
 * the preview is never written by a script the strategy rules out.
 */
export function keptScripts(answer: ScriptStrategyAnswer, strategyId?: string, outcome: string = PREVIEW_ENGINE_OUTCOME): PreviewScript[] {
  const kept = answer.scripts.filter((s) => s.kept && answer.keptDynasties.includes(s.dynasty)).map((s) => ({ dynasty: s.dynasty, version: s.version }));
  if (kept.length === 0) {
    const why = answer.scripts.map((s) => `${s.dynasty}: ${s.reason ?? "not kept"}`).join("; ");
    const scope = strategyId ? `strategy ${strategyId}` : "no strategy";
    throw new PreviewWriterError(
      422,
      `Under ${scope}, the ${outcome === PREVIEW_ENGINE_OUTCOME ? "email" : outcome} Engine (${outcome}) keeps no script to write with${why ? ` (${why})` : " (it has no runnable script)"}, so no preview can be written`,
      "NO_SCRIPT_KEPT",
    );
  }
  return kept;
}

/** The name a writer gives its writing call (`template.pick` place `writer`: tactic `templates.writer` else `template`). */
export const PREVIEW_WRITER_PLACE = "writer";

/**
 * The pipe whose writing the preview stands for: the cold email pipe (Lead found -> Positive reply). Its cold email
 * script is picked in the Engine the catalogue states on THIS pipe (`stepTransitions[].outcome`, else its `to` step),
 * never a hand-typed outcome (prod 2026-11-13: `email_sent`).
 */
export const PREVIEW_WRITER_PIPE = { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" } as const;

/** The Engine the catalogue states for the preview's pipe. Absent = features-service's catalogue moved: 502, no guess. */
export function writerEngineOnCatalogue(catalogue: ChannelCatalogue): string {
  const transition = transitionOnCatalogue(catalogue, PREVIEW_WRITER_PIPE);
  const engine = transition?.outcome || transition?.to?.key;
  if (!engine) {
    throw new PreviewWriterError(
      502,
      `features-service's channel catalogue states no Engine for the cold email pipe (${PREVIEW_WRITER_PIPE.featureSlug} ${PREVIEW_WRITER_PIPE.legKey}), so the preview cannot pick its cold email script`,
    );
  }
  return engine;
}

/** One live version of the cold email pipe's Engine's scripts (workflow-service `GET /scripts?outcome=`), as far as the preview reads it. */
export interface EngineScriptRow {
  dynasty: string;
  version: number;
  tactics: Record<string, unknown> | null;
}

/**
 * The kept scripts of the cold email pipe's Engine that WRITE their email: those whose tactic `asks` names the Engine
 * the preview runs (`message_written`). A script of that Engine that asks no writer (an email pushed already written) has no writing call a preview can stand for. None = a named refusal.
 */
export function writingScriptsOf(rows: EngineScriptRow[], keptDynasties: string[], engine: string, strategyId?: string): string[] {
  const kept = new Set(keptDynasties);
  const writing = [
    ...new Set(
      rows
        .filter((r) => kept.has(r.dynasty))
        .filter((r) => {
          const asks = r.tactics?.asks;
          return Array.isArray(asks) && asks.includes(PREVIEW_ENGINE_OUTCOME);
        })
        .map((r) => r.dynasty),
    ),
  ];
  if (writing.length === 0) {
    throw new PreviewWriterError(
      422,
      `Under ${strategyId ? `strategy ${strategyId}` : "no strategy"}, the ${engine} Engine keeps no script that writes its email through ${PREVIEW_ENGINE_OUTCOME} (kept: ${keptDynasties.join(", ") || "none"}), so no preview can be written`,
      "NO_SCRIPT_KEPT",
    );
  }
  return writing;
}

/** The value a script states for one of its calls: the per-place tactic (`<plural>[place]`) first, else the script-wide one. */
function placedTactic(tactics: Record<string, unknown> | null, singular: string, plural: string, place: string): unknown {
  const perPlace = tactics?.[plural];
  if (perPlace && typeof perPlace === "object" && !Array.isArray(perPlace) && place in perPlace) {
    return (perPlace as Record<string, unknown>)[place];
  }
  return tactics?.[singular];
}

/**
 * ONE-WRITER-N-MODELS-1116 (owner 2026-11-16: « le choix du model est orthogonal / indépendant du script »): a cold
 * email SENDER names no template and no LLM; it asks a WRITER (Engine `message_written`, one script per way of
 * writing, tactic `template`) handing it `generation_request`, and the writer asks the LLM completion Engine
 * (`llm_completion`, one script per model). The Rating picks each for the script that asks (`askedBy`).
 */
export const GENERATION_REQUEST = "generation_request";

/** What a sender hands the writer it asks (its `ctx.ask` units): the Rating picks among writers reading it. */
export const SENDER_HANDS_WRITER = [GENERATION_REQUEST] as const;

/** The `askedBy` the Rating keys its note on: the asking script, `<outcome>/<dynasty>`. */
export function askedByOf(outcome: string, script: PreviewScript): string {
  return `${outcome}/${script.dynasty}`;
}

/** The template dynasty a picked WRITER (one way of writing) states: tactic `template`. None = a named refusal. */
export function templateOfWriter(tactics: Record<string, unknown> | null, script: PreviewScript): string {
  const template = placedTactic(tactics, "template", "templates", PREVIEW_WRITER_PLACE);
  if (typeof template !== "string" || !template.trim()) {
    throw new PreviewWriterError(422, `The Rating picked the writer ${PREVIEW_ENGINE_OUTCOME}/${script.dynasty} v${script.version}, which states no template, so no preview can be written`, "SCRIPT_STATES_NO_TEMPLATE");
  }
  return template;
}

/** Everything that writes one preview: the sender it stands for, the writer it runs, the writer's template (head). */
export interface PreviewWriterPlan {
  /** The cold email script (sender) the Rating picked: the preview stands for its writing, never runs it. */
  emailScript: PreviewScript & { engine: string };
  /** The way of writing the Rating picked for that sender: the script the preview RUNS. */
  writerScript: PreviewScript;
  /** The writer's tactic `template`. */
  templateDynastySlug: string;
  /** That dynasty's head type: the template the writer's materials are read with. */
  promptType: string;
}

/** The writer's identity in the stored preview's key and row: a new writer version or template writes anew. */
export function scriptSlugOf(script: PreviewScript): string {
  return `${PREVIEW_ENGINE_OUTCOME}/${script.dynasty}/v${script.version}`;
}

/** The sample recipient's facts under the lead variable names the Engine's cold-email script fills from a lead. */
const RECIPIENT_TO_VARIABLE: Array<[keyof PreviewRecipient, string]> = [
  ["firstName", "leadFirstName"],
  ["lastName", "leadLastName"],
  ["title", "leadTitle"],
  ["headline", "leadHeadline"],
  ["companyName", "leadCompanyName"],
  ["companyIndustry", "leadCompanyIndustry"],
  ["companyDescription", "leadCompanyDescription"],
  ["companyDomain", "leadCompanyWebsiteUrl"],
];

export interface PreviewVariableValues {
  recipient: PreviewRecipient;
  /** The brand's name (brand-service). */
  clientName: string;
  /** brand-service extract-fields `fields`, for the brand facts the cold-email script asks. */
  brandExtractedFields: unknown;
  /** `YYYY-MM-DD`. */
  currentDate: string;
}

/**
 * The template variables for one preview: what a campaign run fills from the lead, taken from the sample recipient
 * (a fact it does not carry is left out, or "" when the template asks for it: never invented), plus the brand's name,
 * its extracted facts and today's date. Template inputs still missing are the route's to ask of brand-service.
 */
export function previewVariables(values: PreviewVariableValues, templateTokens: readonly string[]): Record<string, unknown> {
  const tokens = new Set(templateTokens);
  const variables: Record<string, unknown> = {
    clientName: values.clientName,
    brandExtractedFields: values.brandExtractedFields,
    currentDate: values.currentDate,
  };
  for (const [field, name] of RECIPIENT_TO_VARIABLE) {
    const value = values.recipient[field];
    if (typeof value === "string" && value.trim()) variables[name] = value;
    else if (tokens.has(name)) variables[name] = "";
  }
  // Any other lead fact the template asks for (company size, funding stage...) is one the sample recipient never
  // carries: "", never asked of brand-service (it would answer about the BRAND). `lead*` is the person's half of the
  // writer's variables, the split `writerUnits` hands the script.
  for (const token of tokens) {
    if (token.startsWith("lead") && !(token in variables)) variables[token] = "";
  }
  return variables;
}
