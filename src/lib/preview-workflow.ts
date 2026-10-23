/**
 * WHICH WORKFLOW WRITES THE SIGNED-OUT PREVIEW, AND HOW ITS INPUTS ARE FILLED.
 *
 * The preview is the email a visitor would receive from us once they pay, so it is
 * written with the prompt template AND the model of the fleet's best MATURE cold-email
 * workflow (owner 2026-10-06). Nothing here names a template or a model: both are read
 * at request time off the live ranking and the winning workflow's DAG, so a new best
 * workflow changes the preview with no deploy.
 *
 *  - The ranking is features-service's `GET /public/stats/leg-workflow-ranking` on the
 *    positive-reply leg (`lead_found_to_conversation`) of `sales-cold-email-outreach`. The
 *    row with `moneyGoesHere` is "the best mature workflow" (owner rule 2026-09-30, its
 *    `lib/leg-workflow-ranking.ts`); the other selectable mature rows follow it in rank
 *    order, cheapest first. Learning rows are never candidates.
 *  - The template + model are what a campaign run of that workflow writes with. An older
 *    workflow states them as a literal `type` + `model` on its content-generation
 *    `POST /generate` node. A workflow upgraded since BEST-TPL-LLM-1022 (2026-10-22) states
 *    neither: it maps `body.type` from the `template-head` node (the head of the template
 *    dynasty features-service's `writer-pick` chose) and `body.model` from `writer-plan`
 *    (the LLM the same pick chose). For those the preview asks features-service the same
 *    question (`writerFromRanking`, PREVIEW-PICK-1023) and writes with that dynasty's head,
 *    exactly as the run's `template-head` call resolves it. No thinking / reasoning
 *    override: `/generate` sends none, so neither does the preview.
 *  - The node's `body.variables.*` input mapping says where each template input comes
 *    from. A preview has no lead, so every source is resolved from what it DOES hold
 *    (`resolvePreviewVariables`). A lead field the sample recipient lacks is "" (unknown,
 *    the template's honesty floor forbids inventing it). A source a preview cannot
 *    honestly stand in for (the lead's scraped landing page of a `-landing` template,
 *    or any source this module does not know) makes the workflow UNUSABLE for a preview,
 *    and the next mature workflow is tried (`planPreviewWorkflow`).
 *
 * Pure leaf (no I/O, never `vi.mock`'d).
 */
import type { ChatModel } from "./chat-models.js";
import type { PreviewRecipient } from "./preview-email.js";

/** The feature whose fleet ranking picks the preview's workflow. */
export const PREVIEW_FEATURE_SLUG = "sales-cold-email-outreach";
/** The leg a cold email is bought for: a positive reply (features-service `lead_found_to_conversation`). */
export const PREVIEW_LEG_KEY = "lead_found_to_conversation";

/** One row of features-service's leg ranking, as far as the preview reads it. */
export interface LegRankingRow {
  rank: number;
  workflowDynastySlug: string;
  /** False when the leg cannot run the workflow right now; absent = runnable. */
  executable?: boolean;
  selectable: boolean;
  isMature: boolean | null;
  basis: "mature" | "flash";
  costPerOutcomeUsd: number | null;
  moneyGoesHere: boolean;
}

export interface LegRanking {
  computedAt: string | null;
  rows: LegRankingRow[];
}

/**
 * The mature workflows the preview may use, best first: the `moneyGoesHere` row, then
 * every other selectable mature one in the ranking's own order. Throws when the ranking
 * was never computed or names no best mature workflow: there is nothing honest to write
 * with, and no fallback template or model.
 */
export function matureCandidates(ranking: LegRanking): LegRankingRow[] {
  if (!ranking.computedAt) {
    throw new PreviewWorkflowError(503, "features-service has not computed the cold-email workflow ranking yet (computedAt is null)");
  }
  const best = ranking.rows.find((r) => r.moneyGoesHere);
  if (!best) {
    throw new PreviewWorkflowError(503, `features-service ranking names no best mature workflow for ${PREVIEW_FEATURE_SLUG} on ${PREVIEW_LEG_KEY}`);
  }
  const others = ranking.rows
    .filter((r) => r !== best && r.selectable && r.isMature === true && r.basis === "mature" && r.costPerOutcomeUsd != null)
    .sort((a, b) => a.rank - b.rank);
  return [best, ...others];
}

/**
 * One play of the cold-email pipe, as far as the preview reads it (features-service
 * `GET /internal/catalogue/plays/:id`): the workflows a campaign running it may run, and
 * the play's own measured best when it has one.
 */
export interface PreviewPlay {
  id: string;
  allowedWorkflowDynastySlugs: string[];
  bestWorkflowSlug: string | null;
}

/** The play id of a strategy on the preview's pipe (features-service `<pipe>~<strategy>`). */
export function previewPlayId(strategyId: string): string {
  return `${PREVIEW_FEATURE_SLUG}|${PREVIEW_LEG_KEY}~${strategyId}`;
}

/**
 * The workflows a campaign restricted to `play` would write with, in the order it would
 * reach for them: the play's own measured best first (when it has one), then every other
 * workflow the play allows in the leg ranking's order (campaign-service seeds a campaign
 * with features-service's first choice on the leg minus what its play rules out). Learning
 * workflows are candidates here, unlike the default preview: a play that allows only
 * learning workflows runs them, so they ARE what its campaign writes. A workflow the leg
 * cannot execute is never a candidate. None left = 503, never another play's workflow.
 */
export function playCandidates(ranking: LegRanking, play: PreviewPlay): LegRankingRow[] {
  if (!ranking.computedAt) {
    throw new PreviewWorkflowError(503, "features-service has not computed the cold-email workflow ranking yet (computedAt is null)");
  }
  const allowed = new Set(play.allowedWorkflowDynastySlugs);
  const rows = ranking.rows
    .filter((r) => allowed.has(r.workflowDynastySlug) && r.executable !== false)
    .sort((a, b) => a.rank - b.rank);
  const best = play.bestWorkflowSlug ? rows.find((r) => r.workflowDynastySlug === play.bestWorkflowSlug) : undefined;
  const ordered = best ? [best, ...rows.filter((r) => r !== best)] : rows;
  if (ordered.length === 0) {
    throw new PreviewWorkflowError(503, `play ${play.id} allows no workflow the cold-email leg ranking can run`);
  }
  return ordered;
}

/** Where one template input comes from, in terms of what a preview holds. */
export type PreviewSource =
  | { kind: "recipient"; field: RecipientField }
  /** A lead fact the sample recipient never carries: "" when the template asks for it, else absent. */
  | { kind: "lead-unknown"; path: string }
  | { kind: "brand-intel"; part: "whole" | "fields" }
  /** One value inside the extract-fields response (`brand-extract-fields.output.<path>`). */
  | { kind: "brand-intel-path"; path: string }
  | { kind: "brands" }
  | { kind: "brand"; path: string | null }
  | { kind: "current-date" }
  | { kind: "literal"; value: unknown };

type RecipientField = "firstName" | "lastName" | "title" | "headline" | "companyName" | "companyIndustry" | "companyDescription" | "companyDomain";

/** Lead-service paths (under `fetch-lead.output.lead.data.`) a sample recipient can carry. */
const LEAD_PATH_TO_RECIPIENT: Record<string, RecipientField> = {
  firstName: "firstName",
  lastName: "lastName",
  currentTitle: "title",
  title: "title",
  headline: "headline",
  "organization.name": "companyName",
  "organization.industry": "companyIndustry",
  "organization.shortDescription": "companyDescription",
  "organization.websiteUrl": "companyDomain",
};

export interface PreviewPlan {
  workflowSlug: string;
  workflowDynastySlug: string;
  promptType: string;
  model: ChatModel;
  /** Template variable name → where its value comes from. */
  sources: Record<string, PreviewSource>;
  /**
   * The `fields` the workflow's own `brand-extract-fields` node asks brand-service for
   * (keys AND descriptions, so brand-service answers from its 30-day cache). Null when the
   * template is not fed brand intel.
   */
  brandIntelFields: Array<{ key: string; description: string }> | null;
}

/**
 * Who writes, as the DAG states it: a literal template + model, or features-service's
 * run-time pick (template dynasty head + LLM), read per preview by the client.
 */
export type PreviewWriter = { kind: "literal"; promptType: string; model: ChatModel } | { kind: "pick" };

/** What the DAG alone says; `promptType` + `model` are known once the writer is resolved. */
export type PreviewDagPlan = Omit<PreviewPlan, "promptType" | "model"> & { writer: PreviewWriter };

export type PlanResult = { ok: true; plan: PreviewDagPlan } | { ok: false; reason: string };

/** The refs an upgraded workflow's `/generate` node reads its template + model from (workflow-service BEST-TPL-LLM-1022). */
const PICKED_TYPE_REF = "$ref:template-head.output.template.type";
const PICKED_MODEL_REF = "$ref:writer-plan.output.model";

/**
 * `/generate` keys that tie the email to the lead it is for, not to what it says. A preview
 * has no lead: `leadId` only tells /generate which lead to read the language off (no lead =
 * English, as the route documents), `apolloEnrichmentId` only links the stored row to the
 * lead's enrichment.
 */
const LEAD_LINK_KEYS = new Set(["body.leadId", "body.apolloEnrichmentId"]);

export interface WorkflowForPlan {
  workflowSlug: string;
  workflowDynastySlug: string;
  dag: unknown;
}

interface DagNode {
  id?: unknown;
  config?: { service?: unknown; path?: unknown; method?: unknown; body?: unknown };
  inputMapping?: Record<string, unknown>;
}

/** Map one `$ref:` (or literal) onto a preview source; null when a preview cannot stand in for it. */
function sourceOf(value: unknown): PreviewSource | null {
  if (typeof value !== "string" || !value.startsWith("$ref:")) return { kind: "literal", value };
  const ref = value.slice("$ref:".length);
  if (ref === "flow_input.currentDate") return { kind: "current-date" };
  if (ref === "brand-extract-fields.output") return { kind: "brand-intel", part: "whole" };
  if (ref === "brand-extract-fields.output.fields") return { kind: "brand-intel", part: "fields" };
  if (ref.startsWith("brand-extract-fields.output.")) return { kind: "brand-intel-path", path: ref.slice("brand-extract-fields.output.".length) };
  if (ref === "brands-fetch.output.brands") return { kind: "brands" };
  if (ref === "brand-profile.output.brand") return { kind: "brand", path: null };
  if (ref.startsWith("brand-profile.output.brand.")) return { kind: "brand", path: ref.slice("brand-profile.output.brand.".length) };
  const LEAD = "fetch-lead.output.lead.data.";
  if (ref.startsWith(LEAD)) {
    const path = ref.slice(LEAD.length);
    const field = LEAD_PATH_TO_RECIPIENT[path];
    return field ? { kind: "recipient", field } : { kind: "lead-unknown", path };
  }
  return null;
}

/**
 * Read the workflow's content-generation `/generate` node into a preview plan, or say
 * why a preview cannot reproduce it.
 */
export function planPreviewWorkflow(workflow: WorkflowForPlan): PlanResult {
  const nodes = ((workflow.dag as { nodes?: unknown })?.nodes ?? []) as DagNode[];
  const generate = Array.isArray(nodes)
    ? nodes.filter((n) => n?.config?.service === "content-generation" && n?.config?.path === "/generate")
    : [];
  if (generate.length !== 1) {
    return { ok: false, reason: `${workflow.workflowSlug} has ${generate.length} content-generation /generate nodes (a preview reproduces exactly one)` };
  }
  const node = generate[0];
  const body = (node.config?.body ?? {}) as Record<string, unknown>;
  const extraBodyKeys = Object.keys(body).filter((k) => k !== "type" && k !== "model");
  if (extraBodyKeys.length > 0) {
    return { ok: false, reason: `${workflow.workflowSlug} /generate states ${extraBodyKeys.join(", ")}, which the preview does not reproduce` };
  }
  const mapping = node.inputMapping ?? {};
  const mappedType = mapping["body.type"];
  const mappedModel = mapping["body.model"];
  let writer: PreviewWriter;
  if (mappedType === undefined && mappedModel === undefined) {
    const promptType = body.type;
    if (typeof promptType !== "string" || promptType.length === 0) {
      return { ok: false, reason: `${workflow.workflowSlug} /generate states no template type` };
    }
    const model = body.model;
    if (typeof model !== "string" || model.length === 0) {
      return { ok: false, reason: `${workflow.workflowSlug} /generate states no model (got ${JSON.stringify(model)})` };
    }
    writer = { kind: "literal", promptType, model: model as ChatModel };
  } else if (mappedType === PICKED_TYPE_REF && mappedModel === PICKED_MODEL_REF && body.type === undefined && body.model === undefined) {
    writer = { kind: "pick" };
  } else {
    return {
      ok: false,
      reason: `${workflow.workflowSlug} /generate takes its template from ${JSON.stringify(mappedType ?? body.type)} and its model from ${JSON.stringify(mappedModel ?? body.model)}, which is neither a stated template + model nor features-service's writer pick`,
    };
  }

  const sources: Record<string, PreviewSource> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (key === "body.type" || key === "body.model" || LEAD_LINK_KEYS.has(key)) continue;
    if (!key.startsWith("body.variables.")) {
      return { ok: false, reason: `${workflow.workflowSlug} /generate maps ${key}, which the preview does not reproduce` };
    }
    const name = key.slice("body.variables.".length);
    const source = sourceOf(value);
    if (!source) {
      return { ok: false, reason: `${workflow.workflowSlug} feeds template input ${name} from ${String(value)}, which a preview cannot supply` };
    }
    sources[name] = source;
  }

  let brandIntelFields: PreviewPlan["brandIntelFields"] = null;
  if (Object.values(sources).some((s) => s.kind === "brand-intel" || s.kind === "brand-intel-path")) {
    const extract = nodes.find((n) => n?.id === "brand-extract-fields");
    const fields = (extract?.config?.body as { fields?: unknown } | undefined)?.fields;
    const valid = Array.isArray(fields) && fields.length > 0 && fields.every((f) => typeof f?.key === "string" && typeof f?.description === "string");
    if (!valid) {
      return { ok: false, reason: `${workflow.workflowSlug} feeds brand intel but its brand-extract-fields node states no literal field list` };
    }
    brandIntelFields = (fields as Array<{ key: string; description: string }>).map((f) => ({ key: f.key, description: f.description }));
  }

  return {
    ok: true,
    plan: { workflowSlug: workflow.workflowSlug, workflowDynastySlug: workflow.workflowDynastySlug, writer, sources, brandIntelFields },
  };
}

/**
 * One side (templates or LLMs) of features-service's `GET /public/stats/leg-writer-ranking`,
 * as far as the preview reads it. `best` is the row a run's `writer-pick` serves: both come
 * out of the same ranking for the same pipe and strategy (features-service `servedRankings`).
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
 * The template dynasty + model name a run on this pipe (and strategy) writes with today.
 * The model name follows `writer-pick`'s own rule: the LLM dynasty slug when it is an active
 * alias, else the first active alias of that dynasty. No pick = 503 in plain words, never
 * another template or model.
 */
export function writerFromRanking(ranking: WriterRanking, strategyId?: string): { templateDynastySlug: string; model: ChatModel } {
  const scope = strategyId ? `the cold-email pipe under strategy ${strategyId}` : "the cold-email pipe";
  if (!ranking.computedAt) {
    throw new PreviewWorkflowError(503, `features-service has not computed which template and LLM write on ${scope} yet`, "WRITER_PICK_UNAVAILABLE");
  }
  const t = ranking.templates.best;
  if (!t?.templateDynastySlug) {
    throw new PreviewWorkflowError(503, `features-service picks no template to write with on ${scope} (${ranking.templates.unavailableReason ?? "no reason given"}), so no preview can be written`, "WRITER_PICK_UNAVAILABLE");
  }
  const l = ranking.llms.best;
  const active = (l?.aliases ?? []).filter((a) => a.status === "active");
  const alias = active.find((a) => a.alias === l?.llmDynastySlug) ?? active[0];
  if (!l || !alias) {
    throw new PreviewWorkflowError(503, `features-service picks no LLM to write with on ${scope} (${ranking.llms.unavailableReason ?? (l ? `no active name for ${l.llmDynastySlug}` : "no reason given")}), so no preview can be written`, "WRITER_PICK_UNAVAILABLE");
  }
  return { templateDynastySlug: t.templateDynastySlug, model: alias.alias as ChatModel };
}

/** The final plan once the writer is known (literal, or the dynasty head + picked model). */
export function withWriter(plan: PreviewDagPlan, promptType: string, model: ChatModel): PreviewPlan {
  const { writer: _writer, ...rest } = plan;
  return { ...rest, promptType, model };
}

export interface PreviewSourceValues {
  recipient: PreviewRecipient;
  /** brand-service extract-fields response, whole. */
  brandIntel: { fields?: unknown } & Record<string, unknown>;
  /** brand-service `GET /internal/brands?ids=` rows for the brand. Null when the plan never asked. */
  brands: Array<Record<string, unknown>> | null;
  /** `YYYY-MM-DD`, as workflow-service puts it on every run's flow input. */
  currentDate: string;
}

/** True when the plan needs brand-service's brand rows (`brands-fetch` / `brand-profile`). */
export function planNeedsBrandRows(plan: Pick<PreviewPlan, "sources">): boolean {
  return Object.values(plan.sources).some((s) => s.kind === "brands" || s.kind === "brand");
}

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * The template variables for one preview, resolved through the workflow's own input
 * mapping. A value the preview does not hold is "" when the template asks for it
 * (`templateTokens`) and absent otherwise, so the recipient-context block only shows
 * facts that are real. A token the workflow does not map at all is left out: `/generate`
 * asks brand-service for it (Convention 1), and so does the preview route, which then
 * fills whatever is still missing with "" so no `{{token}}` leaks. A run-time-picked
 * template is not authored with its workflow, so it commonly declares inputs the workflow
 * never maps (a named template's client name and website on a workflow written for another).
 */
export function resolvePreviewVariables(plan: PreviewPlan, values: PreviewSourceValues, templateTokens: readonly string[]): Record<string, unknown> {
  const tokens = new Set(templateTokens);
  const variables: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(plan.sources)) {
    let value: unknown;
    switch (source.kind) {
      case "recipient":
        value = values.recipient[source.field];
        break;
      case "lead-unknown":
        value = undefined;
        break;
      case "brand-intel":
        value = source.part === "fields" ? values.brandIntel.fields : values.brandIntel;
        break;
      case "brand-intel-path":
        value = readPath(values.brandIntel, source.path);
        break;
      case "brands":
        value = values.brands;
        break;
      case "brand": {
        const row = values.brands?.[0];
        value = source.path === null ? row : readPath(row, source.path);
        break;
      }
      case "current-date":
        value = values.currentDate;
        break;
      case "literal":
        value = source.value;
        break;
    }
    if (value === undefined || value === null || value === "") {
      if (tokens.has(name)) variables[name] = "";
      continue;
    }
    variables[name] = value;
  }
  return variables;
}

/** A failure to pick the preview's workflow, carried with the status the route answers. */
export class PreviewWorkflowError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "PreviewWorkflowError";
  }
}
