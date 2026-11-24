/**
 * chat-service's media transcriptions (REELS-1124): an open Whisper model on our own box, $0, run
 * and measured by chat-service under the caller's run. This client starts a job and reads it; what
 * the job answers is normalized by transcript.ts. Contract = chat-service's served openapi
 * (`POST /orgs/media-transcriptions`, `GET /orgs/media-transcriptions/{id}`):
 *  - chat-service fetches the recording ITSELF from a PUBLIC https url (a box-internal address is
 *    refused), so it is handed the source's own download link, never a file of ours;
 *  - the same org + `idempotencyKey` answers the same job; a retry after `failed` needs a new key;
 *  - the summary carries no transcript: once `completed`, segments and words are read with `include`.
 * chat-service declares no outcome: the caller's script declares `video_transcribed` on the job id.
 */
import { fetchWithRetry } from "../fetch-retry.js";
import { type Tracking, buildTrackingHeaders } from "../tracking.js";

export type TranscriptionIdentity = Tracking & { runId: string };

export interface TranscriptionRead {
  status: "running" | "done" | "failed";
  error?: string;
  /** The transcriber's answer, as it gave it (normalizeTranscript reads it). */
  raw?: unknown;
}

/** A refusal chat-service answered (4xx): retrying the same request cannot succeed. */
export class TranscriptionRefusedError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "TranscriptionRefusedError";
  }
}

const base = () => process.env.CHAT_SERVICE_URL || "http://localhost:3030";
const headers = (identity: TranscriptionIdentity) => ({
  "Content-Type": "application/json",
  "X-Api-Key": process.env.CHAT_SERVICE_API_KEY || "",
  ...buildTrackingHeaders(identity),
});

export async function startTranscription(params: { url: string; language?: string | null; idempotencyKey: string }, identity: TranscriptionIdentity): Promise<{ ref: string }> {
  const response = await fetchWithRetry(
    `${base()}/orgs/media-transcriptions`,
    { method: "POST", headers: headers(identity), body: JSON.stringify({ url: params.url, idempotencyKey: params.idempotencyKey, ...(params.language ? { language: params.language } : {}) }) },
    { label: "chat-service POST /orgs/media-transcriptions" },
  );
  const text = await response.text();
  if (!response.ok) {
    const message = `chat-service refused the transcription: ${response.status} - ${text.slice(0, 300)}`;
    if (response.status >= 400 && response.status < 500) throw new TranscriptionRefusedError(response.status, message);
    throw new Error(message);
  }
  const body = JSON.parse(text) as { id?: unknown };
  if (typeof body.id !== "string" || !body.id) throw new Error(`chat-service answered no transcription id: ${text.slice(0, 200)}`);
  return { ref: body.id };
}

async function getJob(ref: string, query: string, identity: TranscriptionIdentity): Promise<Response> {
  return fetchWithRetry(
    `${base()}/orgs/media-transcriptions/${encodeURIComponent(ref)}${query}`,
    { method: "GET", headers: headers(identity) },
    { label: "chat-service GET /orgs/media-transcriptions/{id}" },
  );
}

export async function readTranscription(ref: string, identity: TranscriptionIdentity): Promise<TranscriptionRead> {
  const response = await getJob(ref, "", identity);
  if (response.status === 404) return { status: "failed", error: `chat-service knows no transcription ${ref} for this org` };
  if (!response.ok) throw new Error(`chat-service transcription read failed: ${response.status} - ${(await response.text()).slice(0, 300)}`);
  const summary = (await response.json()) as { status?: unknown; error?: { code?: unknown; message?: unknown }; language?: unknown };
  if (summary.status === "failed") {
    const e = summary.error ?? {};
    return { status: "failed", error: [e.code, e.message].filter((x) => typeof x === "string" && x).join(": ") || "the transcription failed" };
  }
  if (summary.status !== "completed") return { status: "running" };
  // The whole recording at once: ~1.5 MB of words for 2 h, read once and stored.
  const full = await getJob(ref, "?include=segments,words", identity);
  if (!full.ok) throw new Error(`chat-service transcript read failed: ${full.status} - ${(await full.text()).slice(0, 300)}`);
  const body = (await full.json()) as { language?: unknown; text?: unknown; segments?: unknown; words?: unknown };
  return { status: "done", raw: { language: body.language, text: body.text, segments: body.segments, words: body.words } };
}
