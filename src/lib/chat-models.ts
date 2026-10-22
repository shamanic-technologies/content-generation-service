// Model names and providers for chat-service POST /complete (LLM-DYNASTY-1022-CG).
//
// The set of accepted names is NOT kept here: chat-service serves it on
// `GET /internal/models` and `src/lib/chat-model-catalogue.ts` reads it (LLM dynasty
// slugs like `claude-opus`, each head's exact model id, legacy aliases like `opus`).
// A hand-kept copy lived here until 2026-10-22 and fell behind each time chat-service
// shipped a model. The provider of a name is read from that catalogue too.
//
// Kept in its OWN module (never `vi.mock`'d) so schemas.ts can read DEFAULT_MODEL at
// module-eval time while ~13 suites mock chat-service-client.js.

/** A name chat-service's `/complete` accepts (validated at run time against its catalogue). */
export type ChatModel = string;

export type ChatProvider =
  | "anthropic"
  | "google"
  | "deepseek"
  | "zai"
  | "moonshot"
  | "openai";

// Default when the caller omits `model`: the Gemini Pro dynasty, the model the
// historical `pro` default ran (chat-service redirects `pro` to the same head).
export const DEFAULT_MODEL: ChatModel = "gemini-pro";
