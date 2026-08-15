import { extractTemplateVariableNames } from "./template-vars.js";
import { type ChatModel, MODEL_TO_PROVIDER, DEFAULT_MODEL } from "./chat-models.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { type Tracking, buildTrackingHeaders } from "./tracking.js";
import { unescapeLineBreaks, collapseEscapedLineBreaks } from "./escaped-line-breaks.js";
import { textToHtml } from "./text-to-html.js";

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
//  - GOOGLE / VERCEL: permissive (no `additionalProperties: false`). Gemini
//    ignores that keyword; the Vercel AI Gateway forwards the schema verbatim as
//    OpenAI `response_format.json_schema` and imposes no such requirement. This
//    is the historical schema, sent for every model that is not anthropic.
//  - ANTHROPIC: strict (`additionalProperties: false` on the object AND on
//    `emails.items`). Anthropic's structured-output API 400s on permissive
//    schemas, so the strict variant is sent ONLY for anthropic models. The
//    google path stays byte-identical to before `model` existed.
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

// ─── Chat-service response type ─────────────────────────────────────────────

interface ChatCompleteResponse {
  content: string;
  json: { subject: string; emails: Array<{ body: string; daysSinceLastStep: number }> };
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
  let prompt = substituteVariables(params.promptTemplate, params.variables);

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

  const model = params.model ?? DEFAULT_MODEL;
  const provider = MODEL_TO_PROVIDER[model];
  // Anthropic structured-output requires the strict schema; google ignores it.
  const responseSchema =
    provider === "anthropic" ? GENERATE_RESPONSE_SCHEMA_STRICT : GENERATE_RESPONSE_SCHEMA;

  const response = await fetchWithRetry(
    `${CHAT_SERVICE_URL}/complete`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: prompt,
        systemPrompt: GLOBAL_SYSTEM_PROMPT,
        responseSchema,
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
    throw new Error(`chat-service /complete failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as ChatCompleteResponse;

  const parsed = parseSequenceFromJson(data.json);

  return {
    ...parsed,
    tokensInput: data.tokensInput,
    tokensOutput: data.tokensOutput,
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
  const response = await fetchWithRetry(
    `${CHAT_SERVICE_URL}/complete`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        message: prompt,
        systemPrompt,
        provider: MODEL_TO_PROVIDER[model],
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
    throw new Error(`chat-service /complete failed: ${response.status} - ${errorText}`);
  }

  return await response.json() as ChatTextResponse;
}

function cleanPitchText(raw: string): string {
  // Restore over-escaped line breaks first: fence/quote stripping below matches
  // on real whitespace, and the pitch is rendered as-is to a human.
  let text = unescapeLineBreaks(raw).trim();
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
  emails: Array<{ body: string; daysSinceLastStep: number }>;
}): {
  subject: string;
  sequence: SequenceStep[];
} {
  const sequence: SequenceStep[] = json.emails.map((email, i) => {
    // Over-escaped newlines must become real newlines BEFORE textToHtml, or the
    // body renders as one paragraph with visible backslash-n for the prospect.
    const bodyText = unescapeLineBreaks(email.body).trim();
    return {
      step: i + 1,
      bodyHtml: textToHtml(bodyText),
      bodyText,
      daysSinceLastStep: email.daysSinceLastStep,
    };
  });

  return { subject: collapseEscapedLineBreaks(json.subject), sequence };
}
