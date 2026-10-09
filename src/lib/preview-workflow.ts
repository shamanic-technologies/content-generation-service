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
 *  - The template + model are the `type` + `model` the DAG's content-generation
 *    `POST /generate` node states, exactly as a campaign run sends them. No thinking /
 *    reasoning override: `/generate` sends none, so neither does the preview.
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
import { CHAT_MODELS, type ChatModel } from "./chat-models.js";
import type { PreviewRecipient } from "./preview-email.js";

/** The feature whose fleet ranking picks the preview's workflow. */
export const PREVIEW_FEATURE_SLUG = "sales-cold-email-outreach";
/** The leg a cold email is bought for: a positive reply (features-service `lead_found_to_conversation`). */
export const PREVIEW_LEG_KEY = "lead_found_to_conversation";

/** One row of features-service's leg ranking, as far as the preview reads it. */
export interface LegRankingRow {
  rank: number;
  workflowDynastySlug: string;
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

/** Where one template input comes from, in terms of what a preview holds. */
export type PreviewSource =
  | { kind: "recipient"; field: RecipientField }
  /** A lead fact the sample recipient never carries: "" when the template asks for it, else absent. */
  | { kind: "lead-unknown"; path: string }
  | { kind: "brand-intel"; part: "whole" | "fields" }
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

export type PlanResult = { ok: true; plan: PreviewPlan } | { ok: false; reason: string };

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
  const promptType = body.type;
  if (typeof promptType !== "string" || promptType.length === 0) {
    return { ok: false, reason: `${workflow.workflowSlug} /generate states no literal template type` };
  }
  const model = body.model;
  if (typeof model !== "string" || !(CHAT_MODELS as readonly string[]).includes(model)) {
    return { ok: false, reason: `${workflow.workflowSlug} /generate states no known literal model (got ${JSON.stringify(model)})` };
  }

  const sources: Record<string, PreviewSource> = {};
  for (const [key, value] of Object.entries(node.inputMapping ?? {})) {
    // The lead id only tells /generate which lead to read the language off; a preview has
    // no lead, so it writes without a language directive (English), as the route documents.
    if (key === "body.leadId") continue;
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
  if (Object.values(sources).some((s) => s.kind === "brand-intel")) {
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
    plan: { workflowSlug: workflow.workflowSlug, workflowDynastySlug: workflow.workflowDynastySlug, promptType, model: model as ChatModel, sources, brandIntelFields },
  };
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
export function planNeedsBrandRows(plan: PreviewPlan): boolean {
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
 * facts that are real. Every declared token ends up present, so no `{{token}}` leaks.
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
  for (const token of tokens) {
    if (!(token in variables)) variables[token] = "";
  }
  return variables;
}

/** A failure to pick the preview's workflow, carried with the status the route answers. */
export class PreviewWorkflowError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "PreviewWorkflowError";
  }
}
