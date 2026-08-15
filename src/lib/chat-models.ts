// Model aliases accepted by chat-service POST /complete + the alias→provider map.
//
// Kept in its OWN module (not chat-service-client.ts) on purpose: schemas.ts reads
// CHAT_MODELS at module-eval time for the `model` Zod enum, and ~13 unit tests fully
// `vi.mock` chat-service-client.js WITHOUT re-exporting its constants. Importing the
// enum from there would make z.enum(undefined) crash every one of those suites. This
// module is never mocked, so the alias set is always real. (Same defer-the-access
// philosophy as the schema/auth mock gotcha in CLAUDE.md.)

// Version-free model aliases. The 9 are unique across providers, so the provider is
// derived from the alias — callers pick ONE model, never a provider/model pair.
//
// `deepseek-flash` (DeepSeek V4 Flash) and `deepseek-pro` (DeepSeek V4 Pro) are served
// by the provider slug `deepseek`: chat-service v0.51.0 removed the Vercel AI Gateway
// (it resold these models well above the vendors' list prices) and now calls DeepSeek
// directly over its OpenAI-compatible API. The slug `vercel` no longer exists in
// chat-service's `/complete` schema, so a request carrying it is rejected with 400
// before it reaches a model. Both aliases and the slug are chat-service's spelling,
// read off its deployed schema — never invented here. That direct-vendor path is
// TEXT-IN / TEXT-OUT only — chat-service 400s on `webSearch` / `imageUrl`. Neither of
// this service's two generation paths sends either field, so nothing here depends on a
// capability the models lack. The one caveat is JSON mode: `/generate` forwards a
// `responseSchema`, and neither DeepSeek V4 model advertises `response_format` support,
// so the vendor may ignore the schema. That is best-effort but never silent —
// chat-service's JSON parse fails loud (502) on output it cannot read, so a malformed
// sequence is an error, not a half-filled email. The free-text pitch route sends no
// schema and is unaffected.
export const CHAT_MODELS = [
  "haiku",
  "sonnet",
  "opus",
  "flash-lite",
  "flash",
  "flash-pro",
  "pro",
  "deepseek-flash",
  "deepseek-pro",
] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];

export const MODEL_TO_PROVIDER: Record<ChatModel, "anthropic" | "google" | "deepseek"> = {
  haiku: "anthropic",
  sonnet: "anthropic",
  opus: "anthropic",
  "flash-lite": "google",
  flash: "google",
  "flash-pro": "google",
  pro: "google",
  "deepseek-flash": "deepseek",
  "deepseek-pro": "deepseek",
};

// Default when the caller omits `model` — preserves the historical google/pro path.
export const DEFAULT_MODEL: ChatModel = "pro";
