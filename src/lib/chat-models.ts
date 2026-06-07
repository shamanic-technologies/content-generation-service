// Model aliases accepted by chat-service POST /complete + the alias→provider map.
//
// Kept in its OWN module (not chat-service-client.ts) on purpose: schemas.ts reads
// CHAT_MODELS at module-eval time for the `model` Zod enum, and ~13 unit tests fully
// `vi.mock` chat-service-client.js WITHOUT re-exporting its constants. Importing the
// enum from there would make z.enum(undefined) crash every one of those suites. This
// module is never mocked, so the alias set is always real. (Same defer-the-access
// philosophy as the schema/auth mock gotcha in CLAUDE.md.)

// Version-free model aliases. The 7 are unique across providers, so the provider is
// derived from the alias — callers pick ONE model, never a provider/model pair.
export const CHAT_MODELS = ["haiku", "sonnet", "opus", "flash-lite", "flash", "flash-pro", "pro"] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];

export const MODEL_TO_PROVIDER: Record<ChatModel, "anthropic" | "google"> = {
  haiku: "anthropic",
  sonnet: "anthropic",
  opus: "anthropic",
  "flash-lite": "google",
  flash: "google",
  "flash-pro": "google",
  pro: "google",
};

// Default when the caller omits `model` — preserves the historical google/pro path.
export const DEFAULT_MODEL: ChatModel = "pro";
