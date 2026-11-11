/**
 * The recorded chat-service request of an email generation (FACTORY-P3-RECORD-SYSTEM-PROMPT) is served
 * ONLY by GET /internal/generations/recorded. Every whole-row read of `email_generations`
 * (GET /generations, by-enrichment, by-lead) spreads this into its drizzle `columns` so its response
 * stays the shape it always was and does not grow by a system prompt + voice per row.
 * Standalone leaf: no import, so suites that mock the schema or db never see it change.
 */
export const RECORDED_REQUEST_COLUMNS_OFF = { chatRequest: false, chatRequestInputs: false, recordedText: false } as const;

/**
 * RECORDED-ORDER-1111: what the recorded read serves, kept as the exact JSON TEXT it was written from.
 * Postgres `jsonb` re-orders object keys (shorter keys first: `title` before `organization_id`), so a
 * `variables_raw` read back from jsonb no longer renders the request the writer sent (a lead's employment
 * history listed in another key order: 400/400 recorded generations failed workflow-service's byte-for-byte
 * replay, 2026-11-11). `recorded_text` stores `JSON.stringify` of these four values in the SAME insert;
 * `JSON.parse` gives back every object with its original key order.
 */
export interface RecordedValues {
  variables: unknown;
  request: unknown;
  inputs: unknown;
  response: unknown;
}

export function recordedText(values: RecordedValues): string {
  return JSON.stringify({ variables: values.variables, request: values.request, inputs: values.inputs, response: values.response });
}

/**
 * The values to serve: the stored text when the row has one (written since RECORDED-ORDER-1111), else the
 * jsonb columns (rows written before: their key order is jsonb's and cannot be recovered).
 */
export function readRecordedValues(row: { recordedText: string | null; variablesRaw: unknown; chatRequest: unknown; chatRequestInputs: unknown; responseRaw: unknown }): RecordedValues & { keyOrder: "original" | "jsonb" } {
  if (row.recordedText) {
    const v = JSON.parse(row.recordedText) as RecordedValues;
    return { variables: v.variables ?? null, request: v.request ?? null, inputs: v.inputs ?? null, response: v.response ?? null, keyOrder: "original" };
  }
  return { variables: row.variablesRaw, request: row.chatRequest, inputs: row.chatRequestInputs, response: row.responseRaw, keyOrder: "jsonb" };
}
