// chat-service typed judgments (Jev). Classification goes here, never /complete.
//
// Tier mirrors the caller: an org request asks `POST /orgs/judgments` with the
// inbound identity (org-billed, chat-service provisions/authorizes/actualizes the
// input-token spend on its own run under our x-run-id); a platform request with no
// org asks `POST /internal/platform-judgments` (platform-billed). chat-service
// declares the cost in both cases, so this service declares nothing.

import { fetchWithRetry } from "./fetch-retry.js";
import { type Tracking, buildTrackingHeaders } from "./tracking.js";

const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || "http://localhost:3030";
const CHAT_SERVICE_API_KEY = process.env.CHAT_SERVICE_API_KEY || "";

export type JudgmentCaller =
  | { mode: "org"; tracking: Tracking & { runId: string } }
  | { mode: "platform" };

export interface JudgmentsResponse {
  model: string;
  answers: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
}

/** A non-2xx from chat-service. `status` is chat-service's own. */
export class JudgmentsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "JudgmentsError";
    this.status = status;
  }
}

export async function askJudgments(
  body: { state: string | Record<string, unknown>; questions: Record<string, unknown> },
  caller: JudgmentCaller,
): Promise<JudgmentsResponse> {
  const path = caller.mode === "org" ? "/orgs/judgments" : "/internal/platform-judgments";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": CHAT_SERVICE_API_KEY,
    ...(caller.mode === "org" ? buildTrackingHeaders(caller.tracking) : {}),
  };
  const response = await fetchWithRetry(
    `${CHAT_SERVICE_URL}${path}`,
    { method: "POST", headers, body: JSON.stringify(body) },
    { label: `chat-service ${path}` },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new JudgmentsError(
      response.status,
      `chat-service ${path} failed: ${response.status} - ${text}`,
    );
  }
  return (await response.json()) as JudgmentsResponse;
}
