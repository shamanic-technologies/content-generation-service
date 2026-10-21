import { extractTemplateVariableNames } from "./template-vars.js";

/**
 * Template dynasties (TPL-DYNASTY-1021-CG, owner 2026-10-21) — the rules. I/O lives in
 * template-dynasty-query.ts, routes in src/routes/template-dynasties.ts.
 *
 * A dynasty is ONE email strategy on ONE pipe (feature_slug x leg_key), cross-org: the same
 * strategy on two pipes is two dynasties. Its versions are ordinary `prompts` rows, in order;
 * its HEAD is the latest. A workflow names a dynasty and writes with its head, so a fix added
 * as a new version reaches every workflow of that kind of email, and stats pool across the
 * versions. Every generation still records the exact version it rendered (`prompt_type`).
 *
 * A template belongs to ONE dynasty, never two (owner 2026-10-21: « complètement interdit, et doit
 * être interdit en dur »): the database refuses it (unique prompt_type) and every write refuses it
 * first (TEMPLATE_IN_OTHER_DYNASTY). The 21 texts that sat in two were split by drizzle/0038: the
 * second dynasty holds a copy (`copiedFrom` = the original, whose name its pipe's past emails carry).
 * A template in no dynasty is simply unattached (old press/hiring/VC templates).
 *
 * Only the head is Active (TPL-DYNASTY-1021-CG3, owner 2026-10-21): a version that is the head
 * of NO dynasty is deprecated with reason UPGRADED_REASON, when a new head is added (same write)
 * and by the one-shot backfill (src/bin/deprecate-upgraded-dynasty-versions.ts). Never a head,
 * never a template already deprecated (its stated reason stays), never a re-activation.
 *
 * One status rule per dynasty (TPL-DYNASTY-ROWS-1021-CG, owner 2026-10-21: « Toutes les versions
 * de la dynastie sauf la dernière sont deprecated. Si toutes les versions sont deprecated, alors la
 * dynastie est deprecated, et réciproquement. »):
 * - IN a dynasty, every version but the head is Deprecated (`statusInDynasty`); with one dynasty
 *   per template this equals the template's own status.
 * - The dynasty's own `status` is its head's: Deprecated exactly when every version is.
 *   Deprecating the head template deprecates the dynasty.
 * - A staff re-activation of a template that heads no dynasty it belongs to is refused
 *   (NOT_DYNASTY_HEAD); creating a dynasty over stored templates deprecates its non-head versions;
 *   a fork (`PUT /prompts`, `PUT /prompt-assignments`) of a dynasty version is refused
 *   (SOURCE_IN_DYNASTY): a new version of a dynasty is added to the dynasty, never left orphan.
 */

export const UPGRADED_REASON = "Upgraded";

/** Who a dynasty upgrade's deprecation is recorded as when no staff email came with the write. */
export const UPGRADED_BY_SYSTEM = "template-dynasty-upgrade";

export const DYNASTY_IDENTITIES = ["blind", "named"] as const;
export type DynastyIdentity = (typeof DYNASTY_IDENTITIES)[number];

export interface TemplateVariable {
  name: string;
  description: string;
}

export type VersionStatus = "active" | "deprecated";

export interface DynastyVersion {
  type: string;
  position: number;
  /** The template's own staff status (catalogue-status.ts). */
  status: VersionStatus;
  /** Its status IN this dynasty: the head's own status; every older version Deprecated. */
  statusInDynasty: VersionStatus;
  /** Why it is deprecated in this dynasty (null when active): the template's stated reason, else UPGRADED_REASON. */
  statusReasonInDynasty: string | null;
  /** The template this version was copied from (a split shared text), else null. */
  copiedFrom: string | null;
  addedAt: string;
}

/** The status block a dynasty serves: its head's. */
export interface DynastyStatus {
  status: VersionStatus;
  statusReason: string | null;
  statusChangedBy: string | null;
  statusChangedAt: string | null;
}

export interface DynastyResponse extends DynastyStatus {
  slug: string;
  name: string;
  description: string;
  signature: string;
  identity: DynastyIdentity;
  featureSlug: string;
  legKey: string;
  /** Latest version's type; null only for a dynasty with no version (never in prod). */
  head: string | null;
  versions: DynastyVersion[];
  createdAt: string;
  updatedAt: string;
}

/** A refusal that names its code, answered as `{ error, code, ...extra }`. */
export class TemplateDynastyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TemplateDynastyError";
  }

  toResponseBody(): Record<string, unknown> {
    return { error: this.message, code: this.code, ...this.extra };
  }
}

export function dynastyNotFound(slug: string): TemplateDynastyError {
  return new TemplateDynastyError(404, "DYNASTY_NOT_FOUND", `No template dynasty "${slug}"`);
}

/** A new version whose text is byte-identical to a stored template: it would split one text's stats in two. */
export function templateTwin(twinType: string): TemplateDynastyError {
  return new TemplateDynastyError(
    409,
    "TEMPLATE_TWIN",
    `This text is byte-identical to the stored template "${twinType}". A version must change the text.`,
    { twinType },
  );
}

/**
 * A new version must be writable by every workflow already on the dynasty: those workflows
 * send the head's variables, so a token the head does not declare would render empty for all
 * of them. Dropping a token is fine (the extra variable is simply unused). The declared
 * `variables` must be exactly the tokens the text uses.
 */
export function assertVersionVariables(
  prompt: string,
  variables: ReadonlyArray<TemplateVariable>,
  head: { type: string; variables: ReadonlyArray<TemplateVariable> },
): void {
  const tokens = new Set(extractTemplateVariableNames(prompt));
  const headNames = new Set(head.variables.map((v) => v.name));

  const added = [...tokens].filter((t) => !headNames.has(t));
  if (added.length > 0) {
    throw new TemplateDynastyError(
      400,
      "VARIABLE_NOT_IN_HEAD",
      `{{${added.join("}}, {{")}}} is not declared by the head "${head.type}": the workflows on this dynasty do not send it.`,
      { variables: added },
    );
  }
  assertVariablesMatchText(prompt, variables);
}

/** The declared `variables` must be exactly the {{tokens}} the text uses (VARIABLES_MISMATCH). */
export function assertVariablesMatchText(prompt: string, variables: ReadonlyArray<TemplateVariable>): void {
  const tokens = new Set(extractTemplateVariableNames(prompt));
  const declared = new Set(variables.map((v) => v.name));
  const undeclared = [...tokens].filter((t) => !declared.has(t));
  const unused = [...declared].filter((d) => !tokens.has(d));
  if (undeclared.length > 0 || unused.length > 0) {
    throw new TemplateDynastyError(
      400,
      "VARIABLES_MISMATCH",
      `variables must list exactly the {{tokens}} the text uses` +
        (undeclared.length ? `; undeclared: ${undeclared.join(", ")}` : "") +
        (unused.length ? `; unused: ${unused.join(", ")}` : ""),
    );
  }
}

/** The head of an ordered version list = the highest position. */
export function headOf(versions: ReadonlyArray<{ type: string; position: number }>): string | null {
  let head: { type: string; position: number } | null = null;
  for (const v of versions) if (!head || v.position > head.position) head = v;
  return head?.type ?? null;
}

/** One version as stored, with its template's own status (served shape: catalogue-status servedStatus). */
export interface StoredVersion {
  type: string;
  position: number;
  copiedFrom?: string | null;
  addedAt: string;
  status: VersionStatus;
  statusReason: string | null;
  statusChangedBy: string | null;
  statusChangedAt: string | null;
}

/**
 * The dynasty status rule (owner 2026-10-21): in a dynasty only the head may be Active; the dynasty
 * is its head's status. A dynasty with no version (never in prod) reads Deprecated.
 */
export function applyDynastyStatus(stored: ReadonlyArray<StoredVersion>): { head: string | null; versions: DynastyVersion[]; status: DynastyStatus } {
  const head = headOf(stored);
  const versions = stored.map((v): DynastyVersion => {
    const isHead = v.type === head;
    const inDynasty: VersionStatus = isHead ? v.status : "deprecated";
    return {
      type: v.type,
      position: v.position,
      status: v.status,
      statusInDynasty: inDynasty,
      statusReasonInDynasty: inDynasty === "active" ? null : v.status === "deprecated" ? v.statusReason : UPGRADED_REASON,
      copiedFrom: v.copiedFrom ?? null,
      addedAt: v.addedAt,
    };
  });
  const headRow = stored.find((v) => v.type === head);
  const status: DynastyStatus = headRow
    ? { status: headRow.status, statusReason: headRow.status === "deprecated" ? headRow.statusReason : null, statusChangedBy: headRow.statusChangedBy, statusChangedAt: headRow.statusChangedAt }
    : { status: "deprecated", statusReason: "No version", statusChangedBy: null, statusChangedAt: null };
  return { head, versions, status };
}

/** A staff re-activation of a version that heads none of its dynasties (the rule would break). */
export function notDynastyHead(type: string, heldBy: ReadonlyArray<{ slug: string; head: string | null }>): TemplateDynastyError {
  const where = heldBy.map((d) => `"${d.slug}" (head ${d.head ?? "none"})`).join(", ");
  return new TemplateDynastyError(
    409,
    "NOT_DYNASTY_HEAD",
    `"${type}" is an older version of ${where}: only a dynasty's latest version can be Active. ` +
      `Re-activate the head, or add this text to the dynasty as a new version.`,
    { dynasties: heldBy.map((d) => ({ slug: d.slug, head: d.head })) },
  );
}

/** A template already in another dynasty: one template, one dynasty (owner 2026-10-21). */
export function templateInOtherDynasty(type: string, dynastySlug: string): TemplateDynastyError {
  return new TemplateDynastyError(
    409,
    "TEMPLATE_IN_OTHER_DYNASTY",
    `"${type}" is already a version of the template dynasty "${dynastySlug}": a template belongs to one dynasty only. ` +
      `Add a new text instead.`,
    { dynastySlug },
  );
}

/** A fork of a dynasty version outside its dynasty would land a version in no dynasty. */
export function sourceInDynasty(type: string, slugs: ReadonlyArray<string>): TemplateDynastyError {
  return new TemplateDynastyError(
    409,
    "SOURCE_IN_DYNASTY",
    `"${type}" is a version of the template dynasty ${slugs.map((s) => `"${s}"`).join(", ")}: ` +
      `add the new text to the dynasty (POST /internal/template-dynasties/{slug}/versions), never as a loose copy.`,
    { dynasties: [...slugs] },
  );
}
