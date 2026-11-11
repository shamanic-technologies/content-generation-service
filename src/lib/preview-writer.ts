/**
 * WHO WRITES THE SIGNED-OUT PREVIEW, AND WITH WHAT (PREVIEW-EMAIL-503-1111).
 *
 * The preview is the first email a campaign would send, written the way the campaign writes it: by the email
 * Engine's SCRIPT (workflow-service, Engine `message_written`), with the template + LLM features-service picks, from
 * the materials this service builds for every script writer (`script-writer.ts` `writerUnits`). No workflow, no play,
 * no leg ranking of workflows: a brand with zero history and no campaign always gets an email.
 *
 *  - The script: the scripts the strategy keeps for the Engine, asked of features-service with NO campaign
 *    (`GET /internal/script-strategy?outcome=message_written[&strategyId=]`; no strategy = no condition = every
 *    runnable script), then workflow-service's Rating picks among them (`POST /internal/engines/{outcome}/pick`, the
 *    run's own `pickScript`; never a pick by hand here). None = a named refusal (`NO_SCRIPT_KEPT`), never another
 *    strategy's script.
 *  - The template + LLM: features-service's writer pick for cold email (`GET /public/stats/leg-writer-ranking`, the same
 *    best rows a run's `features.writer_pick` serves), narrowed by the strategy when there is one. The template is the
 *    picked dynasty's head, exactly as a run's `content.template_head` reads it.
 *  - The inputs: a preview has no lead. Its lead facts come from the sample recipient, the brand's from brand-service,
 *    under the variable names the Engine's cold-email script fills (`previewVariables`). A template input nothing
 *    fills is asked of brand-service like `/generate` (Convention 1), then "" (never invented).
 *
 * Pure leaf (no I/O, never `vi.mock`'d).
 */
import type { ChatModel } from "./chat-models.js";
import type { PreviewRecipient } from "./preview-email.js";

/** The email Engine: the outcome its scripts make. */
export const PREVIEW_ENGINE_OUTCOME = "message_written";

/** The materials a preview hands the script (`writerUnits`): the Rating considers only scripts that run on them. */
export const PREVIEW_WRITER_MATERIALS = ["lead_identified", "brand_context", "template_written"] as const;

/**
 * Where features-service ranks cold-email templates + LLMs (its writer pick reads the same rows). The only place the
 * preview names it; the script is chosen per Engine, never per pipe.
 */
export const WRITER_RANKING_FEATURE_SLUG = "sales-cold-email-outreach";
export const WRITER_RANKING_LEG = "lead_found_to_conversation";

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
 * One side (templates or LLMs) of features-service's `GET /public/stats/leg-writer-ranking`, as far as the preview
 * reads it. `best` is the row a run's writer pick serves.
 */
export interface WriterRanking {
  computedAt: string | null;
  templates: { best: { templateDynastySlug: string } | null; unavailableReason: string | null };
  llms: {
    best: { llmDynastySlug: string; aliases: Array<{ alias: string; status: string }> } | null;
    unavailableReason: string | null;
  };
}

/**
 * The template dynasty + model name a run writes cold email with today. The model name follows the writer pick's own
 * rule: the LLM dynasty slug when it is an active alias, else the first active alias of that dynasty. No pick = 503 in
 * plain words, never another template or model.
 */
export function writerFromRanking(ranking: WriterRanking, strategyId?: string): { templateDynastySlug: string; model: ChatModel } {
  const scope = strategyId ? `cold email under strategy ${strategyId}` : "cold email";
  if (!ranking.computedAt) {
    throw new PreviewWriterError(503, `features-service has not computed which template and LLM write ${scope} yet`, "WRITER_PICK_UNAVAILABLE");
  }
  const t = ranking.templates.best;
  if (!t?.templateDynastySlug) {
    throw new PreviewWriterError(503, `features-service picks no template to write ${scope} with (${ranking.templates.unavailableReason ?? "no reason given"}), so no preview can be written`, "WRITER_PICK_UNAVAILABLE");
  }
  const l = ranking.llms.best;
  const active = (l?.aliases ?? []).filter((a) => a.status === "active");
  const alias = active.find((a) => a.alias === l?.llmDynastySlug) ?? active[0];
  if (!l || !alias) {
    throw new PreviewWriterError(503, `features-service picks no LLM to write ${scope} with (${ranking.llms.unavailableReason ?? (l ? `no active name for ${l.llmDynastySlug}` : "no reason given")}), so no preview can be written`, "WRITER_PICK_UNAVAILABLE");
  }
  return { templateDynastySlug: t.templateDynastySlug, model: alias.alias as ChatModel };
}

/** Everything that writes one preview: the Engine's script, the picked template (dynasty head) and LLM. */
export interface PreviewWriterPlan {
  script: PreviewScript;
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
