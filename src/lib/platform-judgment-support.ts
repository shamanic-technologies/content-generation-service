// Whose work a platform judgment is (PLATFORM-CALLER-RUN-1024). chat-service's
// platform routes take exactly one of: the caller's run (`x-run-id`), or a
// declared support function (`support: { kind, reason }`) when no run stands
// behind the call by design. Neither is soon refused (400), both is refused now.
//
// Every platform judgment this service asks today judges a TEMPLATE being
// stored (brand/offer neutrality, blind/named identity). A template is no
// outcome: no lead, no message, no reply comes out of storing it. The routes
// carry no run (API key only, no identity headers) and must never forward an
// inbound `x-run-id`: it is not this service's run. So each call site declares
// `platform_llm`, with one sentence naming which write it judges.
//
// Standalone leaf (routes read these at module-eval; never `vi.mock`'d).

export const SUPPORT_FUNCTIONS = [
  "payment_fees",
  "brand_setup",
  "copilot",
  "platform_llm",
  "staff_experiment",
  "product_feature",
  "retired_product",
] as const;

export type SupportFunction = (typeof SUPPORT_FUNCTIONS)[number];

export interface PlatformSupport {
  kind: SupportFunction;
  reason: string;
}

/** `POST /platform-prompts`: an app registers a platform template at cold start. */
export const PLATFORM_PROMPT_REGISTRATION_SUPPORT: PlatformSupport = {
  kind: "platform_llm",
  reason: "Checks that a platform prompt template registered by an app at startup names no brand or offer before it is stored; produces no outcome.",
};

/** `POST /internal/template-dynasties`: a new email strategy (dynasty) is created. */
export const TEMPLATE_DYNASTY_CREATE_SUPPORT: PlatformSupport = {
  kind: "platform_llm",
  reason: "Checks a new template dynasty's text (brand/offer neutral, blind or named identity kept) before it is stored; produces no outcome.",
};

/** `POST /internal/template-dynasties/{slug}/versions`: a dynasty gets a new head. */
export const TEMPLATE_DYNASTY_VERSION_SUPPORT: PlatformSupport = {
  kind: "platform_llm",
  reason: "Checks a new template dynasty version (brand/offer neutral, blind or named identity kept) before it becomes the head; produces no outcome.",
};
