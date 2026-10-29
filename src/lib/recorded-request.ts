/**
 * The recorded chat-service request of an email generation (FACTORY-P3-RECORD-SYSTEM-PROMPT) is served
 * ONLY by GET /internal/generations/recorded. Every whole-row read of `email_generations`
 * (GET /generations, by-enrichment, by-lead) spreads this into its drizzle `columns` so its response
 * stays the shape it always was and does not grow by a system prompt + voice per row.
 * Standalone leaf: no import, so suites that mock the schema or db never see it change.
 */
export const RECORDED_REQUEST_COLUMNS_OFF = { chatRequest: false, chatRequestInputs: false } as const;
