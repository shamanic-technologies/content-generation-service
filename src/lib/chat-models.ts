// Model aliases accepted by chat-service POST /complete + the alias→provider map.
//
// Kept in its OWN module (not chat-service-client.ts) on purpose: schemas.ts reads
// CHAT_MODELS at module-eval time for the `model` Zod enum, and ~13 unit tests fully
// `vi.mock` chat-service-client.js WITHOUT re-exporting its constants. Importing the
// enum from there would make z.enum(undefined) crash every one of those suites. This
// module is never mocked, so the alias set is always real. (Same defer-the-access
// philosophy as the schema/auth mock gotcha in CLAUDE.md.)

// Version-free model aliases. The 13 are unique across providers, so the provider is
// derived from the alias — callers pick ONE model, never a provider/model pair.
//
// Six of them are served by chat-service's DIRECT-VENDOR path (v0.51.0 removed the
// Vercel AI Gateway, which resold these models well above the vendors' list prices;
// the slug `vercel` no longer exists in `/complete`, so a request carrying it is
// rejected with 400 before it reaches a model). One shared OpenAI-compatible adapter
// in chat-service calls each vendor directly, and each vendor resolves its OWN
// key-service credential under its own slug:
//   - `deepseek-flash` (DeepSeek V4 Flash) / `deepseek-pro` (DeepSeek V4 Pro) → `deepseek`
//   - `glm-flash` (glm-4.7-flashx) / `glm-pro` (glm-5.2)                      → `zai`
//   - `kimi-flash` (kimi-k2.6) / `kimi-pro` (kimi-k3)                         → `moonshot`
// Every alias and slug above is chat-service's own spelling, read off its DEPLOYED
// `/complete` schema — never invented here.
//
// That direct-vendor path is TEXT-IN / TEXT-OUT only — chat-service 400s on
// `webSearch` / `imageUrl`. Neither of this service's two generation paths sends
// either field, so nothing here depends on a capability the models lack. The one
// caveat is JSON mode: `/generate` forwards a `responseSchema`, and these vendors do
// not all advertise `response_format` support, so a vendor may ignore the schema.
// That is best-effort but never silent — chat-service's JSON parse fails loud (502)
// on output it cannot read, so a malformed sequence is an error, not a half-filled
// email. The free-text pitch route sends no schema and is unaffected.
//
// Vendor ACCOUNT state is not a routing concern: zai and moonshot authenticate but
// currently carry no balance, so they answer 429 "please recharge", and moonshot's
// two models have no cost row yet (their vendor prices are not published), so a Kimi
// call fails at cost declaration even once funded. Both are account/catalog states,
// handled where they belong (billing / costs-service). There is deliberately NO
// fallback rerouting an out-of-credit vendor to a funded one — an unfunded vendor
// fails loud, with the provider slug named in the error.
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
  "glm-flash",
  "glm-pro",
  "kimi-flash",
  "kimi-pro",
] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];

export type ChatProvider = "anthropic" | "google" | "deepseek" | "zai" | "moonshot";

export const MODEL_TO_PROVIDER: Record<ChatModel, ChatProvider> = {
  haiku: "anthropic",
  sonnet: "anthropic",
  opus: "anthropic",
  "flash-lite": "google",
  flash: "google",
  "flash-pro": "google",
  pro: "google",
  "deepseek-flash": "deepseek",
  "deepseek-pro": "deepseek",
  "glm-flash": "zai",
  "glm-pro": "zai",
  "kimi-flash": "moonshot",
  "kimi-pro": "moonshot",
};

// Default when the caller omits `model` — preserves the historical google/pro path.
export const DEFAULT_MODEL: ChatModel = "pro";
