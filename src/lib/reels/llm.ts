/**
 * The one LLM helper of the reels steps (REELS-1124). Either this service calls chat-service
 * `/complete` itself (`model`: exactly like thread-writer's writeThread, provider read from the
 * catalogue, strict schema for anthropic, 402 passed through), or a script obtained the
 * completion and handed it back (`completion.answer` = chat-service's WHOLE answer).
 *
 * Billed by chat-service on the CALLER's run (identity headers forwarded as received): no run of
 * ours, no cost row, nothing declared here.
 */
import { resolveChatModel } from "../chat-model-catalogue.js";
import { fetchWithRetry } from "../fetch-retry.js";
import { type Tracking, buildTrackingHeaders } from "../tracking.js";
import type { ReelsChatRequest } from "./moments.js";

export class ReelsInsufficientCreditsError extends Error {
  constructor(public balance_cents: number, public required_cents: number) {
    super("Insufficient credits");
    this.name = "ReelsInsufficientCreditsError";
  }
}

export interface HandedBackCompletion { request: Record<string, unknown>; answer: Record<string, unknown>; runId: string }

export interface ReelsAnswer {
  json: unknown;
  model: string | null;
  tokensInput: number;
  tokensOutput: number;
  /** What was sent (ours) or what the script says it sent: stored on the proposal row. */
  request: object;
  responseRaw: object;
}

/** chat-service's whole `/complete` answer, read the same way whoever obtained it. */
export function readAnswer(answer: unknown, request: object): ReelsAnswer {
  const data = (answer && typeof answer === "object" ? answer : {}) as { json?: unknown; model?: unknown; tokensInput?: unknown; tokensOutput?: unknown };
  return {
    json: data.json ?? null,
    model: typeof data.model === "string" ? data.model : null,
    tokensInput: typeof data.tokensInput === "number" ? data.tokensInput : 0,
    tokensOutput: typeof data.tokensOutput === "number" ? data.tokensOutput : 0,
    request,
    responseRaw: data,
  };
}

export async function askReelsLlm(
  request: ReelsChatRequest,
  by: { model: string } | { completion: HandedBackCompletion },
  identity: Tracking & { runId: string },
): Promise<ReelsAnswer> {
  if ("completion" in by) return readAnswer(by.completion.answer, by.completion.request);

  const { provider } = await resolveChatModel(by.model);
  const body = {
    message: request.message,
    systemPrompt: request.systemPrompt,
    responseFormat: request.responseFormat,
    responseSchema: provider === "anthropic" ? request.strictResponseSchema : request.responseSchema,
    maxTokens: request.maxTokens,
    provider,
    model: by.model,
  };
  const base = process.env.CHAT_SERVICE_URL || "http://localhost:3030";
  const response = await fetchWithRetry(
    `${base}/complete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": process.env.CHAT_SERVICE_API_KEY || "", ...buildTrackingHeaders(identity) },
      body: JSON.stringify(body),
    },
    { label: "chat-service /complete" },
  );
  if (response.status === 402) {
    const e = (await response.json().catch(() => ({}))) as { balance_cents?: number; required_cents?: number };
    throw new ReelsInsufficientCreditsError(e.balance_cents ?? 0, e.required_cents ?? 0);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`chat-service /complete failed for provider '${provider}' model '${by.model}': ${response.status} - ${text.slice(0, 500)}`);
  }
  return readAnswer(await response.json(), body);
}
