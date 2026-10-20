/**
 * Staff catalogue status of a template (`prompts.type`) or a writer model alias
 * (`CHAT_MODELS`), TEMPLATE-MODEL-STATUS-1019.
 *
 * - `active` (default for every template and model) or `deprecated`.
 * - Deprecated means: no NEW workflow may name it. workflow-service reads the status on
 *   `GET /platform-prompts` / `GET /internal/models` at workflow write time and refuses.
 * - It is NEVER read by `/generate` or `/preview-email`: a stored workflow that already
 *   names a deprecated template or model keeps generating. Retiring those workflows is
 *   workflow-service's job, not a refusal here.
 * - Cross-org catalogue objects: there is no per-org or per-brand status.
 *
 * Every deprecation states WHY and WHO (DEPRECATION-REASON-1020, owner 2026-10-20): a
 * deprecation without a plain-language reason, or without the staff email the gateway
 * verified (`x-staff-email`), is refused. A row deprecated before reasons existed serves
 * `NOT_SPECIFIED` and no author (nothing invented). Re-activating needs no reason and
 * clears it. No code path here deprecates on its own.
 *
 * Standalone leaf (schemas.ts reads the enum at module-eval).
 */
export const CATALOGUE_STATUSES = ["active", "deprecated"] as const;
export type CatalogueStatus = (typeof CATALOGUE_STATUSES)[number];

/** The reason served for a row deprecated before a reason was required. */
export const NOT_SPECIFIED = "Not specified";

export const MAX_STATUS_REASON_LENGTH = 1000;

/** Header the staff gateway (api-service) sets to the staff email it verified. */
export const STAFF_EMAIL_HEADER = "x-staff-email";

export interface StatusChange {
  status: CatalogueStatus;
  /** Trimmed reason when deprecating, null when re-activating. */
  reason: string | null;
  /** Staff email of who changed it; null only when re-activating without one. */
  changedBy: string | null;
}

export type StatusChangeRefusal = { code: "DEPRECATION_REASON_REQUIRED" | "DEPRECATED_BY_REQUIRED"; error: string };

/** Validates a status change: a deprecation must say why and who. */
export function resolveStatusChange(
  status: CatalogueStatus,
  reason: string | undefined,
  staffEmail: string | undefined
): StatusChange | StatusChangeRefusal {
  const changedBy = staffEmail?.trim().toLowerCase() || null;
  if (status === "active") return { status, reason: null, changedBy };
  const why = reason?.trim();
  if (!why) {
    return {
      code: "DEPRECATION_REASON_REQUIRED",
      error: "A deprecation needs a `reason`: say in plain words why it is deprecated.",
    };
  }
  if (!changedBy) {
    return {
      code: "DEPRECATED_BY_REQUIRED",
      error: `A deprecation needs the ${STAFF_EMAIL_HEADER} header: the staff email of who deprecates it.`,
    };
  }
  return { status, reason: why, changedBy };
}

export interface ServedStatus {
  status: CatalogueStatus;
  statusReason: string | null;
  statusChangedBy: string | null;
  statusChangedAt: string | null;
}

/** What every read serves about a status. Deprecated with no stored reason = NOT_SPECIFIED. */
export function servedStatus(r: {
  status: CatalogueStatus;
  statusReason: string | null;
  statusChangedBy: string | null;
  statusChangedAt: Date | null;
}): ServedStatus {
  return {
    status: r.status,
    statusReason: r.status === "deprecated" ? r.statusReason ?? NOT_SPECIFIED : null,
    statusChangedBy: r.statusChangedBy,
    statusChangedAt: r.statusChangedAt ? r.statusChangedAt.toISOString() : null,
  };
}
