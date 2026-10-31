/**
 * Writes ONE Threads thread (a main post + the replies chained under it) with a stored template
 * (THREADS-IDEAS-AB, owner 2026-10-31: many template dynasties on the Threads posts pipe, the best kept
 * by features-service writer-pick, exactly as for cold email and WhatsApp).
 *
 * The template is the writer's rules (system prompt); the workflow fills its `{{tokens}}` and sends
 * everything it gathered (facts, published figures, angles, history) as the message. One completion
 * through chat-service, billed on the CALLER's run (the workflow run that publishes the thread): no run of
 * our own, no outcome declared here (the publisher declares `post_published` on that run). The writer is
 * trusted: no count or length check, no retry on shape; the parts are only line-break restored,
 * dash-stripped (dashes.ts) and trimmed, so stored = what the workflow publishes. Our client-comms voice is
 * NOT appended: a public post is not a message to a client or a prospect; the template carries the copy rules.
 */
import { resolveChatModel } from "./chat-model-catalogue.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { type Tracking, buildTrackingHeaders } from "./tracking.js";
import { stripDashes } from "./dashes.js";
import { unescapeLineBreaks } from "./escaped-line-breaks.js";
import { missingWhatsAppVariables, renderWhatsAppTemplate, WhatsAppVariablesMissingError, WhatsAppInsufficientCreditsError } from "./whatsapp-writer.js";

// The token rendering and its errors are the WhatsApp writer's, shared as is (one rule for every template writer).
export { WhatsAppVariablesMissingError as ThreadVariablesMissingError, WhatsAppInsufficientCreditsError as ThreadInsufficientCreditsError };
export const missingThreadVariables = missingWhatsAppVariables;
export const renderThreadTemplate = renderWhatsAppTemplate;

const PROPERTIES = {
  subject: { type: "string", description: "The thread's subject in a few words (used to never repeat a subject)." },
  post: { type: "string", description: "The main post, plain text, exactly as published." },
  replies: {
    type: "array",
    items: { type: "string" },
    description: "The replies posted right under the main post, in order, plain text, each exactly as published.",
  },
} as const;
const REQUIRED = ["subject", "post", "replies"];

// Anthropic's structured output 400s on a permissive schema; the other providers get the permissive one.
const RESPONSE_SCHEMA = { type: "object", properties: PROPERTIES, required: REQUIRED } as const;
const RESPONSE_SCHEMA_STRICT = { ...RESPONSE_SCHEMA, additionalProperties: false } as const;

const OUTPUT_FORMAT = [
  "",
  "OUTPUT: answer with the JSON object only: subject (a few words), post (the main post), replies (the replies in order).",
].join("\n");

/** One part as stored and published: line breaks restored, dashes stripped, trimmed. */
export function cleanPart(raw: unknown): string {
  return stripDashes(unescapeLineBreaks(String(raw ?? ""))).trim();
}

export interface ThreadWriteResult {
  subject: string;
  post: string;
  replies: string[];
  model: string;
  tokensInput: number;
  tokensOutput: number;
  systemPrompt: string;
  responseRaw: object;
}

export async function writeThread(
  params: { type: string; promptTemplate: string; variables: Record<string, unknown>; context: string; model: string },
  identity: Tracking & { runId: string },
): Promise<ThreadWriteResult> {
  const rules = renderThreadTemplate(params.type, params.promptTemplate, params.variables);
  const { provider } = await resolveChatModel(params.model);
  const systemPrompt = `${rules}\n${OUTPUT_FORMAT}`;

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
  const data = (await response.json()) as { json?: Record<string, unknown>; tokensInput?: number; tokensOutput?: number; model: string };
  const json = data.json ?? {};
  const post = cleanPart(json.post);
  if (!post) throw new Error(`the model answered no main post: ${JSON.stringify(json).slice(0, 300)}`);
  return {
    subject: cleanPart(json.subject),
    post,
    replies: (Array.isArray(json.replies) ? json.replies : []).map(cleanPart).filter((r) => r !== ""),
    model: data.model,
    tokensInput: data.tokensInput ?? 0,
    tokensOutput: data.tokensOutput ?? 0,
    systemPrompt,
    responseRaw: data,
  };
}
