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
 * Standalone leaf (schemas.ts reads the enum at module-eval).
 */
export const CATALOGUE_STATUSES = ["active", "deprecated"] as const;
export type CatalogueStatus = (typeof CATALOGUE_STATUSES)[number];
