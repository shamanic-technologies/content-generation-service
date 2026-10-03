import { extractTemplateVariableNames } from "./template-vars.js";
import { buildLeadContextBlock } from "./lead-context-block.js";
import { withoutUnquotableBuyingSignal } from "./lead-context-variables.js";
import { type OfferGiveLists, buildGiveListsDirective } from "./offer-give-lists.js";
import {
  type ChatModel,
  type ChatProvider,
  MODEL_TO_PROVIDER,
  DEFAULT_MODEL,
} from "./chat-models.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { type Tracking, buildTrackingHeaders } from "./tracking.js";
import { unescapeLineBreaks, collapseEscapedLineBreaks } from "./escaped-line-breaks.js";
import { textToHtml } from "./text-to-html.js";
import { stripDashes } from "./dashes.js";
import { withSequenceDelays, IncompleteSequenceError } from "./sequence-delays.js";

const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || "http://localhost:3030";
const CHAT_SERVICE_API_KEY = process.env.CHAT_SERVICE_API_KEY || "";

// ─── Template generation ────────────────────────────────────────────────────

// chat-service requires x-run-id; callers always supply runId.
export type ChatServiceIdentity = Tracking & { runId: string };

export interface GenerateFromTemplateParams {
  promptTemplate: string;
  variables: Record<string, unknown>;
  campaignContext?: Record<string, unknown> | null;
  model?: ChatModel;
  /**
   * Language to write the email in, resolved from the recipient. `null` or
   * absent means no directive is emitted and the system prompt stays
   * byte-identical to what it was before this field existed.
   */
  language?: string | null;
  /**
   * The offer's confirmed give lists (what the sender gives for free to a prospect
   * who replies, and what it never gives). Absent, null or both empty → no rule is
   * emitted and the system prompt stays byte-identical. See offer-give-lists.ts.
   */
  giveLists?: OfferGiveLists | null;
  /**
   * Ask the SAME completion to also report, per sentence of the first email, which
   * input it rests on. Absent → the system prompt and response schema are
   * byte-identical to before this existed (every /generate call). Only the
   * signed-out preview sets it; see src/lib/preview-highlights.ts.
   */
  annotate?: { sources: ReadonlyArray<{ id: string; label: string }> } | null;
  /**
   * Ask chat-service for the model's lowest reasoning level (Anthropic: output_config
   * effort "low"; Gemini: its per-model floor). Only the latency-bound preview sets it;
   * absent/false → the key is not sent and `/generate`'s request is byte-identical.
   */
  disableThinking?: boolean;
  /**
   * Called before each REGENERATION (never before the first attempt), with the
   * reason the previous answer was unusable. Lets the route trace it on the run.
   */
  onRegenerate?: (info: { attempt: number; reason: string }) => void;
}

/** One highlight exactly as the model reported it; validated by the caller. */
export interface RawHighlight {
  text: unknown;
  source: unknown;
  reason: unknown;
}

export interface SequenceStep {
  step: number;
  bodyHtml: string;
  bodyText: string;
  daysSinceLastStep: number;
}

export interface GenerateResult {
  subject: string;
  sequence: SequenceStep[];
  tokensInput: number;
  tokensOutput: number;
  model: string;
  promptRaw: string;
  responseRaw: object;
  /** Present only when `annotate` was requested: the model's raw report, unvalidated. */
  highlights?: RawHighlight[];
}

/**
 * Coerce an unknown value to a string for template substitution.
 * - strings pass through
 * - arrays of strings are comma-joined
 * - arrays of objects render as a numbered markdown list, one block per object
 * - plain objects render as a key/value markdown bullet list
 * - everything else (numbers, booleans, null, mixed arrays) is JSON-stringified
 *
 * Multibrand is the default in this platform — brand-related variables
 * commonly arrive as objects or arrays of objects. Rendering them as
 * readable markdown (rather than raw JSON) keeps the prompt clean and lets
 * the LLM consume the values naturally.
 */
export function coerceToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) {
      return value.join(", ");
    }
    if (value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
      return value
        .map((item, i) => `${i + 1}.\n${renderObjectAsMarkdown(item as Record<string, unknown>, "   ")}`)
        .join("\n");
    }
    return JSON.stringify(value);
  }

  return renderObjectAsMarkdown(value as Record<string, unknown>, "");
}

function humanizeKey(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/[_-]+/g, " ").trim().toLowerCase();
}

function renderObjectAsMarkdown(obj: Record<string, unknown>, indent: string): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    const label = humanizeKey(k);
    if (typeof v === "object" && !Array.isArray(v)) {
      lines.push(`${indent}- ${label}:`);
      lines.push(renderObjectAsMarkdown(v as Record<string, unknown>, indent + "  "));
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      lines.push(`${indent}- ${label}: ${v.join(", ")}`);
    } else if (Array.isArray(v) && v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) {
      lines.push(`${indent}- ${label}:`);
      v.forEach((item, i) => {
        lines.push(`${indent}  ${i + 1}.`);
        lines.push(renderObjectAsMarkdown(item as Record<string, unknown>, indent + "     "));
      });
    } else {
      lines.push(`${indent}- ${label}: ${coerceToString(v)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Substitute {{variable}} placeholders in a prompt template with values.
 * Non-string values are coerced via coerceToString.
 */
export function substituteVariables(
  template: string,
  variables: Record<string, unknown>
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, coerceToString(value));
  }
  return result;
}

/**
 * Format campaign featureInputs as a context block prepended to the prompt.
 */
export function formatCampaignContext(featureInputs: Record<string, unknown>): string {
  const lines: string[] = ["## Campaign Context"];
  for (const [key, value] of Object.entries(featureInputs)) {
    if (value == null) continue;
    const label = key.replace(/([A-Z])/g, " $1").replace(/[_-]/g, " ").trim();
    lines.push(`- ${label}: ${coerceToString(value)}`);
  }
  return lines.join("\n");
}

/**
 * Find {{placeholder}} names that remain unfilled after variable substitution.
 */
export function findUnfilledPlaceholders(text: string): string[] {
  return extractTemplateVariableNames(text);
}

// ─── Structured-output schema (google vs anthropic) ─────────────────────────
// Forwarded to chat-service as `responseSchema`, which flips the provider into
// structured-output mode and enforces JSON shape + string escaping server-side.
// Keep in sync with `ChatCompleteResponse.json` below and the schema described
// in GLOBAL_SYSTEM_PROMPT.
//
// Two variants, picked by the resolved provider:
//  - GOOGLE / DEEPSEEK / ZAI / MOONSHOT / OPENAI: permissive (no
//    `additionalProperties: false`). Gemini ignores that keyword; the direct
//    vendors' OpenAI-compatible APIs impose no such requirement either. This is
//    the historical schema, sent for every model that is not anthropic.
//  - ANTHROPIC: strict (`additionalProperties: false` on the object AND on
//    `emails.items`). Anthropic's structured-output API 400s on permissive
//    schemas, so the strict variant is sent ONLY for anthropic models — which
//    now includes `fable`. The google path stays byte-identical to before
//    `model` existed.
const GENERATE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    emails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          body: { type: "string" },
          daysSinceLastStep: { type: "number" },
        },
        required: ["body", "daysSinceLastStep"],
      },
    },
  },
  required: ["subject", "emails"],
} as const;

const GENERATE_RESPONSE_SCHEMA_STRICT = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string" },
    emails: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          body: { type: "string" },
          daysSinceLastStep: { type: "number" },
        },
        required: ["body", "daysSinceLastStep"],
      },
    },
  },
  required: ["subject", "emails"],
} as const;

/**
 * The response schema with a `highlights` array appended AFTER `emails`, so the
 * model writes the email before it writes anything about it. `source` is an enum
 * of the inputs actually present, which structured output enforces where the
 * provider supports it; the caller re-validates either way.
 */
function withHighlightsSchema(
  base: typeof GENERATE_RESPONSE_SCHEMA | typeof GENERATE_RESPONSE_SCHEMA_STRICT,
  sourceIds: string[],
  strict: boolean
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    type: "object",
    properties: {
      text: { type: "string" },
      source: { type: "string", enum: sourceIds },
      reason: { type: "string" },
    },
    required: ["text", "source", "reason"],
  };
  if (strict) item.additionalProperties = false;
  return {
    ...base,
    properties: { ...base.properties, highlights: { type: "array", items: item } },
    required: [...base.required, "highlights"],
  };
}

/**
 * Appended to the system prompt only when annotations are requested. The rule
 * that matters: the annotation reports what the model DID, it never changes what
 * it writes, and it may only name an input from the list it was given.
 */
export function buildAnnotationDirective(sources: ReadonlyArray<{ id: string; label: string }>): string {
  return [
    "",
    "Annotations (a report about the FIRST email, written after it):",
    "- Write the emails exactly as you would without this section. The annotations describe the writing; they must never change it.",
    '- Add a top-level "highlights" array. Cover every sentence of the first email body after the greeting, in order. Each highlight is one sentence or one clause of it.',
    '- "text": copied VERBATIM from the first email body (same characters, same punctuation), never paraphrased.',
    '- "source": the ONE input below that this text rests on. Use a data input when the text states or builds on that fact; use "instruction" only when the text exists because a writing rule asked for it (a greeting, a diagnostic question, the call to action) and no fact below produced it.',
    '- "reason": one short plain-English sentence saying why this text is there, naming the fact or the rule. Never claim a fact that is not in the input you name.',
    "- Allowed sources (id: what it is):",
    ...sources.map((s) => `  - ${s.id}: ${s.label}`),
    '- Return "highlights" inside the same JSON object as "subject" and "emails".',
  ].join("\n");
}

// ─── Global system prompt ────────────────────────────────────────────────────
// Applied to every generation call. Contains universal rules that should NOT
// be repeated in individual prompt templates.
const GLOBAL_SYSTEM_PROMPT = [
  "You are generating email content for an automated sending pipeline.",
  "",
  "Universal rules (always apply, regardless of the prompt):",
  "- NEVER include a sign-off, signature, or footer at the end of the email (e.g. '— [Your name]', 'Best, [Name]', 'Regards, …'). The sending service appends the sender's name, title, and organization automatically. Your output must end with the last sentence of the email body — nothing after it.",
  "- NEVER use placeholders like [Your name], [Company], [Insert X], etc. Every piece of text you produce must be ready to send as-is.",
  "- Template inputs may arrive as strings, arrays, or objects (this platform is multibrand by default — brand-related inputs frequently describe several brands at once). Read whatever shape is provided and weave it naturally; never invent a single primary brand when multiple are given.",
  "",
  "You must respond with a JSON object matching this exact schema:",
  '{"subject": "<email subject line>", "emails": [{"body": "<plain text email body>", "daysSinceLastStep": <number>}]}',
  "- subject: the email subject line (string)",
  "- emails: array of email steps. Each has:",
  "  - body: plain text email body (string)",
  "  - daysSinceLastStep: days to wait since the previous email, 0 for the first (number)",
  "Return ONLY the JSON object, no additional text or markdown.",
].join("\n");

/**
 * The language directive appended to the system prompt when the recipient's
 * language is known and is not English.
 *
 * It lives in the SYSTEM prompt rather than in the prompt templates on purpose:
 * the templates are hand-tuned per org and exist in dozens of versions
 * (cold-email-v9 … v38, blind-discovery-email-v26, …), so a rule placed here
 * reaches every one of them without editing a single stored body.
 *
 * The templates themselves are written in English. That is the language of the
 * INSTRUCTIONS, not of the output — this directive says so explicitly, because
 * a model handed English instructions plus English example copy will otherwise
 * default to answering in English.
 */
export function buildLanguageDirective(language: string): string {
  return [
    "",
    "Language:",
    `- Write the ENTIRE email in ${language} — subject line and every step of the sequence. The recipient does not read English.`,
    "- The instructions and any examples above are written in English purely because that is the language of this prompt. They are NOT a model for the language of your output.",
    `- Keep proper nouns (people, companies, products) as they are given. Everything you write yourself must be natural, idiomatic ${language} as used in business correspondence — not a literal translation of an English sentence.`,
  ].join("\n");
}

// ─── Insufficient credits error ─────────────────────────────────────────────

export class InsufficientCreditsError extends Error {
  status = 402;
  balance_cents: number;
  required_cents: number;

  constructor(balance_cents: number, required_cents: number) {
    super("Insufficient credits");
    this.balance_cents = balance_cents;
    this.required_cents = required_cents;
  }
}

// ─── Chat-service error message ─────────────────────────────────────────────
//
// A failing /complete call names the provider and model it was routed to. Without
// them, a vendor-side failure reads as a generic chat-service outage: the direct-vendor
// providers (deepseek / zai / moonshot) each resolve their own credential and their own
// account balance, so an out-of-credit vendor answers 429 "please recharge" while the
// others keep working. Naming the provider makes that an account problem someone can
// act on rather than an anonymous failure. Nothing is retried or rerouted — an unfunded
// vendor fails loud.
function chatCompleteErrorMessage(
  status: number,
  provider: ChatProvider,
  model: ChatModel,
  errorText: string
): string {
  return `chat-service /complete failed for provider '${provider}' model '${model}': ${status} - ${errorText}`;
}

// ─── Chat-service response type ─────────────────────────────────────────────

// ─── Regenerating an unusable answer ────────────────────────────────────────
//
// A completion can come back with a SHAPE this service cannot use: chat-service
// answers 502 "LLM returned invalid JSON." when the model's text did not parse,
// or the parsed sequence fails `withSequenceDelays` (a follow-up with no delay).
// Both are stochastic model defects — the same request asked again almost always
// comes back usable — and each one used to fail a whole campaign run.
//
// So an unusable answer is asked again, up to MAX_GENERATION_ATTEMPTS in total,
// and the LAST attempt's error is thrown unchanged (same message, same status),
// so a generation that stays unusable fails exactly as loud as before.
//
// Everything else is NOT regenerated here: 402 (credits), 429 (vendor capacity —
// chat-service already spent its own retry budget), a 400 option refusal, a
// generic 5xx ("LLM call failed"), and connect-phase failures (fetchWithRetry owns
// those). Cost stays correct per attempt: chat-service provisions and actualizes
// every /complete call it serves on the run, including the unusable one, and this
// service declares no cost of its own.
export const MAX_GENERATION_ATTEMPTS = 2;

/** chat-service's 502 for model output that did not parse as JSON. */
export class UnusableModelJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableModelJsonError";
  }
}

function isInvalidJsonAnswer(status: number, errorText: string): boolean {
  if (status !== 502) return false;
  try {
    const body = JSON.parse(errorText) as { error?: unknown };
    return typeof body.error === "string" && body.error.startsWith("LLM returned invalid JSON");
  } catch {
    return false;
  }
}

interface ChatCompleteResponse {
  content: string;
  json: { subject: string; emails: Array<{ body: string; daysSinceLastStep?: unknown }> };
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

/**
 * Generate content by substituting variables into a stored prompt template
 * and sending it to chat-service for LLM completion.
 *
 * Chat-service handles key resolution, billing, and cost tracking internally.
 * Output is always a variable-length email sequence.
 */
export async function generateFromTemplate(
  params: GenerateFromTemplateParams,
  identity: ChatServiceIdentity
): Promise<GenerateResult> {
  // A buying signal the email may not quote (see QUOTABLE_BUYING_SIGNAL_TYPES)
  // is dropped before anything is rendered, so no path can show it to the model.
  const variables = withoutUnquotableBuyingSignal(params.variables);
  let prompt = substituteVariables(params.promptTemplate, variables);

  // Lead + organization facts the caller supplied that this template body never
  // asked for. Empty when the caller sent none of them, in which case the prompt
  // is byte-identical to what it was before this block existed.
  const leadContext = buildLeadContextBlock(
    params.promptTemplate,
    variables,
    coerceToString
  );
  if (leadContext) {
    prompt = `${leadContext}\n\n${prompt}`;
  }

  // Inject campaign featureInputs as additional context
  if (params.campaignContext && Object.keys(params.campaignContext).length > 0) {
    const contextBlock = formatCampaignContext(params.campaignContext);
    prompt = `${contextBlock}\n\n${prompt}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": CHAT_SERVICE_API_KEY,
    ...buildTrackingHeaders(identity),
  };

  // Absent language → the system prompt is byte-identical to before this existed.
  let systemPrompt = params.language
    ? `${GLOBAL_SYSTEM_PROMPT}\n${buildLanguageDirective(params.language)}`
    : GLOBAL_SYSTEM_PROMPT;
  const giveListsDirective = params.giveLists ? buildGiveListsDirective(params.giveLists) : "";
  if (giveListsDirective) {
    systemPrompt = `${systemPrompt}\n${giveListsDirective}`;
  }
  const annotate = params.annotate && params.annotate.sources.length > 0 ? params.annotate : null;
  if (annotate) {
    systemPrompt = `${systemPrompt}\n${buildAnnotationDirective(annotate.sources)}`;
  }

  const model = params.model ?? DEFAULT_MODEL;
  const provider = MODEL_TO_PROVIDER[model];
  // Anthropic structured-output requires the strict schema; google ignores it.
  const baseSchema =
    provider === "anthropic" ? GENERATE_RESPONSE_SCHEMA_STRICT : GENERATE_RESPONSE_SCHEMA;
  const responseSchema = annotate
    ? withHighlightsSchema(baseSchema, annotate.sources.map((s) => s.id), provider === "anthropic")
    : baseSchema;

  const requestBody = JSON.stringify({
    message: prompt,
    systemPrompt,
    responseSchema,
    provider,
    model,
    ...(params.disableThinking === true ? { disableThinking: true } : {}),
  });

  // Tokens of every attempt that returned a completion, so the stored figures
  // cover the unusable answer too (an invalid-JSON 502 reports none).
  let tokensInput = 0;
  let tokensOutput = 0;
  let completion: ChatCompleteResponse | undefined;
  let sequence: ReturnType<typeof parseSequenceFromJson> | undefined;

  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchWithRetry(
        `${CHAT_SERVICE_URL}/complete`,
        { method: "POST", headers, body: requestBody },
        { label: "chat-service /complete" }
      );

      if (response.status === 402) {
        const error = await response.json() as { balance_cents: number; required_cents: number };
        throw new InsufficientCreditsError(error.balance_cents, error.required_cents);
      }

      if (!response.ok) {
        const errorText = await response.text();
        const message = chatCompleteErrorMessage(response.status, provider, model, errorText);
        throw isInvalidJsonAnswer(response.status, errorText)
          ? new UnusableModelJsonError(message)
          : new Error(message);
      }

      completion = await response.json() as ChatCompleteResponse;
      tokensInput += completion.tokensInput ?? 0;
      tokensOutput += completion.tokensOutput ?? 0;
      sequence = parseSequenceFromJson(completion.json);
      break;
    } catch (err) {
      const unusable = err instanceof UnusableModelJsonError || err instanceof IncompleteSequenceError;
      if (!unusable || attempt >= MAX_GENERATION_ATTEMPTS) throw err;
      const reason = (err as Error).message;
      console.warn(
        `[content-gen] regenerating unusable sequence: attempt ${attempt + 1}/${MAX_GENERATION_ATTEMPTS} runId=${identity.runId} provider=${provider} model=${model} reason=${reason}`
      );
      params.onRegenerate?.({ attempt: attempt + 1, reason });
    }
  }
  // The loop only exits by `break` after both are set, or by throwing.
  const data = completion!;
  const parsed = sequence!;

  let highlights: RawHighlight[] | undefined;
  if (annotate) {
    const raw = (data.json as { highlights?: unknown }).highlights;
    highlights = Array.isArray(raw)
      ? raw.filter((h): h is RawHighlight => h !== null && typeof h === "object")
      : [];
  }

  return {
    ...parsed,
    ...(highlights ? { highlights } : {}),
    tokensInput,
    tokensOutput,
    model: data.model,
    promptRaw: prompt,
    responseRaw: data,
  };
}

// ─── Pitch generation (free-text, char-range enforced) ─────────────────────
//
// Used by POST /generate-expert-quote-pitch for journalist-quote responses (Featured.com).
// Output is plain text constrained to [minChars, maxChars]. If the first
// attempt is out of range, we retry once with a corrective nudge in the
// system prompt before giving up with ExpertQuotePitchLengthError.

export interface GenerateExpertQuotePitchParams {
  promptTemplate: string;
  variables: Record<string, unknown>;
  minChars: number;
  maxChars: number;
  model?: ChatModel;
}

export interface ExpertQuotePitchResult {
  pitch: string;
  charCount: number;
  attempts: number;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  promptRaw: string;
  responseRaw: object;
}

export class ExpertQuotePitchLengthError extends Error {
  status = 400;
  charCount: number;
  minChars: number;
  maxChars: number;
  attempts: number;
  lastPitch: string;

  constructor(charCount: number, minChars: number, maxChars: number, attempts: number, lastPitch: string) {
    super(`Pitch length ${charCount} chars outside [${minChars}, ${maxChars}] after ${attempts} attempts`);
    this.charCount = charCount;
    this.minChars = minChars;
    this.maxChars = maxChars;
    this.attempts = attempts;
    this.lastPitch = lastPitch;
  }
}

interface ChatTextResponse {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

function buildPitchSystemPrompt(minChars: number, maxChars: number, retry: boolean, lastCharCount: number | null): string {
  const lines = [
    "You are writing a single block of plain text the user will paste into a journalist's quote-request form.",
    "Universal rules:",
    `- The output MUST be between ${minChars} and ${maxChars} characters total. Count carefully.`,
    "- Output the pitch text only — no preamble, no labels, no JSON, no markdown fences, no surrounding quotes.",
    "- Never use placeholders like [Your name] or [Company]. The pitch must be ready to submit as-is.",
    "- Never include a sign-off, signature, or 'Best,' line.",
    "- Template inputs may arrive as strings, arrays, or objects (this platform is multibrand by default). When the expert profile describes multiple brands, speak as the collective — never invent a single primary brand when multiple are given.",
  ];
  if (retry && lastCharCount !== null) {
    if (lastCharCount < minChars) {
      lines.push(
        `Previous attempt was ${lastCharCount} chars — TOO SHORT. Add concrete details, examples, or a second supporting point. Stay between ${minChars} and ${maxChars} characters this time.`
      );
    } else {
      lines.push(
        `Previous attempt was ${lastCharCount} chars — TOO LONG. Trim filler, drop the weakest sentence, keep only the strongest claim. Stay between ${minChars} and ${maxChars} characters this time.`
      );
    }
  }
  return lines.join("\n");
}

async function callChatServiceForText(
  prompt: string,
  systemPrompt: string,
  identity: ChatServiceIdentity,
  model: ChatModel
): Promise<ChatTextResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": CHAT_SERVICE_API_KEY,
    ...buildTrackingHeaders(identity),
  };

  // Free-text pitch: no responseSchema for any provider. Provider derived from alias.
  const provider = MODEL_TO_PROVIDER[model];
  const response = await fetchWithRetry(
    `${CHAT_SERVICE_URL}/complete`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: prompt,
        systemPrompt,
        provider,
        model,
      }),
    },
    { label: "chat-service /complete" }
  );

  if (response.status === 402) {
    const error = await response.json() as { balance_cents: number; required_cents: number };
    throw new InsufficientCreditsError(error.balance_cents, error.required_cents);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(chatCompleteErrorMessage(response.status, provider, model, errorText));
  }

  return await response.json() as ChatTextResponse;
}

function cleanPitchText(raw: string): string {
  // Restore over-escaped line breaks first: fence/quote stripping below matches
  // on real whitespace, and the pitch is rendered as-is to a human.
  let text = stripDashes(unescapeLineBreaks(raw)).trim();
  // Strip surrounding markdown code fences if present (```...``` or ```text...```).
  text = text.replace(/^```(?:[a-z]+)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  // Strip surrounding straight or curly quotes if the entire body is wrapped.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("“") && text.endsWith("”")) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Generate a free-text pitch with strict char-range enforcement.
 * Retries once with a corrective nudge if the first attempt is out of range.
 * Throws ExpertQuotePitchLengthError if both attempts fail; InsufficientCreditsError on 402.
 */
export async function generateExpertQuotePitchFromTemplate(
  params: GenerateExpertQuotePitchParams,
  identity: ChatServiceIdentity
): Promise<ExpertQuotePitchResult> {
  const { promptTemplate, variables, minChars, maxChars } = params;
  const model = params.model ?? DEFAULT_MODEL;
  const prompt = substituteVariables(promptTemplate, variables);

  let lastCharCount: number | null = null;
  let lastPitch = "";
  let totalTokensInput = 0;
  let totalTokensOutput = 0;
  let lastModel = "";
  let lastResponse: ChatTextResponse | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const systemPrompt = buildPitchSystemPrompt(minChars, maxChars, attempt > 1, lastCharCount);
    const data = await callChatServiceForText(prompt, systemPrompt, identity, model);
    lastResponse = data;
    totalTokensInput += data.tokensInput;
    totalTokensOutput += data.tokensOutput;
    lastModel = data.model;

    const pitch = cleanPitchText(data.content);
    lastPitch = pitch;
    lastCharCount = pitch.length;

    if (lastCharCount >= minChars && lastCharCount <= maxChars) {
      return {
        pitch,
        charCount: lastCharCount,
        attempts: attempt,
        tokensInput: totalTokensInput,
        tokensOutput: totalTokensOutput,
        model: lastModel,
        promptRaw: prompt,
        responseRaw: data,
      };
    }
  }

  throw new ExpertQuotePitchLengthError(lastCharCount ?? 0, minChars, maxChars, 2, lastPitch);
}

function parseSequenceFromJson(json: {
  subject: string;
  emails: Array<{ body: string; daysSinceLastStep?: unknown }>;
}): {
  subject: string;
  sequence: SequenceStep[];
} {
  // The model's delays are checked before anything is stored: step 1 without one
  // is 0, any later step without one fails loud (see sequence-delays.ts).
  const emails = withSequenceDelays(json.emails);
  const sequence: SequenceStep[] = emails.map((email, i) => {
    // Over-escaped newlines must become real newlines BEFORE textToHtml, or the
    // body renders as one paragraph with visible backslash-n for the prospect.
    // No em/en dash reaches the prospect (dashes.ts); stripped before storage.
    const bodyText = stripDashes(unescapeLineBreaks(email.body)).trim();
    return {
      step: i + 1,
      bodyHtml: textToHtml(bodyText),
      bodyText,
      daysSinceLastStep: email.daysSinceLastStep,
    };
  });

  return { subject: stripDashes(collapseEscapedLineBreaks(json.subject)), sequence };
}
