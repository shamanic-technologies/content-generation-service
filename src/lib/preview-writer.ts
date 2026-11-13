/**
 * WHO WRITES THE SIGNED-OUT PREVIEW, AND WITH WHAT (PREVIEW-EMAIL-503-1111).
 *
 * The preview is the first email a campaign would send, written the way the campaign writes it: by the email
 * Engine's SCRIPT (workflow-service, Engine `message_written`), with the template + LLM the picked cold email script states, from
 * the materials this service builds for every script writer (`script-writer.ts` `writerUnits`). No workflow, no play,
 * no leg ranking of workflows: a brand with zero history and no campaign always gets an email.
 *
 *  - The script: the scripts the strategy keeps for the Engine, asked of features-service with NO campaign
 *    (`GET /internal/script-strategy?outcome=message_written[&strategyId=]`; no strategy = no condition = every
 *    runnable script), then workflow-service's Rating picks among them (`POST /internal/engines/{outcome}/pick`, the
 *    run's own `pickScript`; never a pick by hand here). None = a named refusal (`NO_SCRIPT_KEPT`), never another
 *    strategy's script.
 *  - The template + LLM: the TACTICS of the cold email script the Rating picks (SCRIPT-VALUE-RATING-1113, owner
 *    2026-11-13: « un pick = toujours un script », « le LLM et le template sont des tactics du script »). The Engine is
 *    the one the catalogue states on the cold email pipe (`PREVIEW_WRITER_PIPE`, `writerEngineOnCatalogue`); its
 *    scripts the strategy keeps (no campaign) that write through `message_written` (tactic `asks`) go to
 *    workflow-service's Rating pick; the picked version's tactics for its `writer` call (`templates.writer` else
 *    `template`, `llms.writer` else `llm`) are what the preview writes with. None stated = a named refusal. The
 *    template is the stated dynasty's head. No side template or LLM pick is asked anywhere.
 *  - The inputs: a preview has no lead. Its lead facts come from the sample recipient, the brand's from brand-service,
 *    under the variable names the Engine's cold-email script fills (`previewVariables`). A template input nothing
 *    fills is asked of brand-service like `/generate` (Convention 1), then "" (never invented).
 *
 * Pure leaf (no I/O, never `vi.mock`'d).
 */
import type { ChatModel } from "./chat-models.js";
import { transitionOnCatalogue, type ChannelCatalogue } from "./pipe-from-step.js";
import type { PreviewRecipient } from "./preview-email.js";

/** The email Engine whose SCRIPTS the preview runs: the outcome its scripts make. */
export const PREVIEW_ENGINE_OUTCOME = "message_written";

/** The materials a preview hands the script (`writerUnits`): the Rating considers only scripts that run on them. */
export const PREVIEW_WRITER_MATERIALS = ["lead_identified", "brand_context", "template_written"] as const;

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
export function keptScripts(answer: ScriptStrategyAnswer, strategyId?: string): PreviewScript[] {
  const kept = answer.scripts.filter((s) => s.kept && answer.keptDynasties.includes(s.dynasty)).map((s) => ({ dynasty: s.dynasty, version: s.version }));
  if (kept.length === 0) {
    const why = answer.scripts.map((s) => `${s.dynasty}: ${s.reason ?? "not kept"}`).join("; ");
    const scope = strategyId ? `strategy ${strategyId}` : "no strategy";
    throw new PreviewWriterError(
      422,
      `Under ${scope}, the email Engine (${PREVIEW_ENGINE_OUTCOME}) keeps no script to write with${why ? ` (${why})` : " (it has no runnable script)"}, so no preview can be written`,
      "NO_SCRIPT_KEPT",
    );
  }
  return kept;
}

/**
 * The name the cold email scripts give their writing call (`pickLlm(ctx, "writer", "message_written")`, reading tactic
 * `llms.writer` else `llm`). The preview IS that call, made before any campaign.
 */
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
 * the preview runs (`message_written`), handing it the template + LLM they state. A script of that Engine that asks no
 * writer (an email pushed already written) has no writing call a preview can stand for. None = a named refusal.
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
 * The template dynasty + LLM the picked cold email script states for its writing call (`PREVIEW_WRITER_PLACE`):
 * `templates.writer` else `template` (a template dynasty slug), `llms.writer` else `llm` (`{ provider, model, name }`,
 * `model` = the name chat-service takes). A script stating none = a named refusal, never a default template or model.
 */
export function writerFromTactics(tactics: Record<string, unknown> | null, script: PreviewScript, engine: string): { templateDynastySlug: string; model: ChatModel } {
  const name = `${engine}/${script.dynasty} v${script.version}`;
  const template = placedTactic(tactics, "template", "templates", PREVIEW_WRITER_PLACE);
  if (typeof template !== "string" || !template.trim()) {
    throw new PreviewWriterError(422, `The Rating picked the cold email script ${name}, which states no template for its ${PREVIEW_WRITER_PLACE} call, so no preview can be written`, "SCRIPT_STATES_NO_TEMPLATE");
  }
  const llm = placedTactic(tactics, "llm", "llms", PREVIEW_WRITER_PLACE) as { model?: unknown } | undefined | null;
  const model = llm && typeof llm === "object" ? llm.model : undefined;
  if (typeof model !== "string" || !model.trim()) {
    throw new PreviewWriterError(422, `The Rating picked the cold email script ${name}, which states no LLM for its ${PREVIEW_WRITER_PLACE} call, so no preview can be written`, "SCRIPT_STATES_NO_LLM");
  }
  return { templateDynastySlug: template, model };
}

/** Everything that writes one preview: the Engine's script, the picked template (dynasty head) and LLM. */
export interface PreviewWriterPlan {
  script: PreviewScript;
  /** The cold email script the Rating picked, whose tactics name the template + LLM. */
  emailScript: PreviewScript & { engine: string };
  templateDynastySlug: string;
  promptType: string;
  model: ChatModel;
}

/** The plan's identity in the stored preview's key and row: a new script version, template or LLM writes anew. */
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
