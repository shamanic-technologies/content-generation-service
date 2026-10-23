/**
 * Writes ONE WhatsApp message (as its bubbles) with a stored template (WA-TEMPLATES-1023).
 *
 * The template is the writer's rules (system prompt); the workflow fills its `{{tokens}}` with the
 * per-run pieces it builds, and sends the run's context (thread, facts, person, local time) as the
 * message. Our voice (client-comms) is appended exactly as for an email. One completion through
 * chat-service, which bills it on the caller's run. The writer is trusted: no count check, no retry
 * on shape; the bubbles are only trimmed and dash-stripped (dashes.ts), so stored = sent.
 */
import { extractTemplateVariableNames } from "./template-vars.js";
import { resolveChatModel } from "./chat-model-catalogue.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { type Tracking, buildTrackingHeaders } from "./tracking.js";
import { readClientCommsVoice, buildClientCommsVoiceDirective } from "./client-comms-voice.js";
import { stripDashes } from "./dashes.js";
import { unescapeLineBreaks } from "./escaped-line-breaks.js";

export class WhatsAppVariablesMissingError extends Error {
  status = 400;
  code = "VARIABLES_MISSING";
  missing: string[];
  constructor(type: string, missing: string[]) {
    super(`Template ${type} needs these variables as strings ("" when none): ${missing.join(", ")}`);
    this.missing = missing;
  }
}

export class WhatsAppInsufficientCreditsError extends Error {
  status = 402;
  constructor(public balance_cents: number, public required_cents: number) {
    super("Insufficient credits");
  }
}

export type WhatsAppDecision = "write" | "later" | "stop";

const PROPERTIES = {
  decision: {
    type: "string",
    enum: ["write", "later", "stop"],
    description:
      "write = send the message now; later = not the right moment (or not a sensible hour where they are), nothing is sent and they are looked at again at nextFollowUpAt; stop = their own words end it. A first message to a new person is always write.",
  },
  bubbles: {
    type: "array",
    items: { type: "string" },
    description:
      "The WhatsApp message as the bubbles the person receives, in order, plain text, exactly as they will read them: each bubble is sent as its own WhatsApp message. Empty unless decision is write.",
  },
  reason: { type: "string", description: "One sentence: what this message is trying to learn or start, or why later or stop." },
  nextFollowUpAt: {
    type: "string",
    description: "When the NEXT follow-up is due, ISO 8601 date-time in UTC, strictly after now. Empty when the rules above say so or decision is stop.",
  },
  nextFollowUpWhy: { type: "string", description: "One sentence: why that date, from the history." },
} as const;
const REQUIRED = ["decision", "bubbles", "reason", "nextFollowUpAt", "nextFollowUpWhy"];

// Anthropic's structured output 400s on a permissive schema; the other providers get the permissive one,
// as /generate does (chat-service-client.ts).
const RESPONSE_SCHEMA = { type: "object", properties: PROPERTIES, required: REQUIRED } as const;
const RESPONSE_SCHEMA_STRICT = { ...RESPONSE_SCHEMA, additionalProperties: false } as const;

const OUTPUT_FORMAT = [
  "",
  "OUTPUT: answer with the JSON object only: decision, bubbles (the message, one string per WhatsApp bubble, in order; an empty list unless decision is write), reason, nextFollowUpAt, nextFollowUpWhy. Where a rule above says \"message\", it means these bubbles.",
].join("\n");

/** The template's tokens the caller did not send as a string. */
export function missingWhatsAppVariables(template: string, variables: Record<string, unknown>): string[] {
  return extractTemplateVariableNames(template).filter((n) => typeof variables[n] !== "string");
}

/** The template with its tokens filled; an empty piece leaves no run of blank lines behind. */
export function renderWhatsAppTemplate(type: string, template: string, variables: Record<string, unknown>): string {
  const missing = missingWhatsAppVariables(template, variables);
  if (missing.length) throw new WhatsAppVariablesMissingError(type, missing);
  let out = template;
  for (const name of extractTemplateVariableNames(template)) {
    out = out.replaceAll(`{{${name}}}`, (variables[name] as string).trim());
  }
  return out.replace(/\n[ \t]*(\n[ \t]*)+\n/g, "\n\n").trim();
}

/** The bubbles as stored and sent: line breaks restored, dashes stripped, trimmed, empty ones dropped. */
export function cleanBubbles(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error(`the model answered no bubbles list: ${JSON.stringify(raw)?.slice(0, 200)}`);
  return raw
    .map((b) => stripDashes(unescapeLineBreaks(String(b ?? ""))).trim())
    .filter((b) => b !== "");
}

export interface WhatsAppWriteResult {
  decision: WhatsAppDecision;
  bubbles: string[];
  reason: string;
  nextFollowUpAt: string;
  nextFollowUpWhy: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  systemPrompt: string;
  responseRaw: object;
}

export async function writeWhatsApp(
  params: { type: string; promptTemplate: string; variables: Record<string, unknown>; context: string; model: string },
  identity: Tracking & { runId: string },
): Promise<WhatsAppWriteResult> {
  const rules = renderWhatsAppTemplate(params.type, params.promptTemplate, params.variables);
  const { provider } = await resolveChatModel(params.model);
  const voice = await readClientCommsVoice();
  const systemPrompt = `${rules}\n${buildClientCommsVoiceDirective(voice)}\n${OUTPUT_FORMAT}`;

  const base = process.env.CHAT_SERVICE_URL || "http://localhost:3030";
  const response = await fetchWithRetry(
    `${base}/complete`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": process.env.CHAT_SERVICE_API_KEY || "",
        ...buildTrackingHeaders(identity),
      },
      body: JSON.stringify({
        message: params.context,
        systemPrompt,
        responseFormat: "json",
        responseSchema: provider === "anthropic" ? RESPONSE_SCHEMA_STRICT : RESPONSE_SCHEMA,
        maxTokens: 16000,
        provider,
        model: params.model,
      }),
    },
    { label: "chat-service /complete" },
  );
  if (response.status === 402) {
    const e = (await response.json()) as { balance_cents: number; required_cents: number };
    throw new WhatsAppInsufficientCreditsError(e.balance_cents, e.required_cents);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`chat-service /complete failed for provider '${provider}' model '${params.model}': ${response.status} - ${text.slice(0, 500)}`);
  }
  const data = (await response.json()) as {
    json?: Record<string, unknown>;
    tokensInput?: number;
    tokensOutput?: number;
    model: string;
  };
  const json = data.json ?? {};
  const decision = json.decision;
  if (decision !== "write" && decision !== "later" && decision !== "stop") {
    throw new Error(`the model answered no decision: ${JSON.stringify(decision)}`);
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    decision,
    // Nothing is sent on later/stop: no bubbles, whatever the model put there.
    bubbles: decision === "write" ? cleanBubbles(json.bubbles) : [],
    reason: str(json.reason),
    nextFollowUpAt: str(json.nextFollowUpAt),
    nextFollowUpWhy: str(json.nextFollowUpWhy),
    model: data.model,
    tokensInput: data.tokensInput ?? 0,
    tokensOutput: data.tokensOutput ?? 0,
    systemPrompt,
    responseRaw: data,
  };
}
