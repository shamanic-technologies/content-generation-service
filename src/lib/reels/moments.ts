/**
 * Picking the moments of a long video worth cutting into short vertical clips (REELS-1124).
 * Pure leaf: builds the chat-service request and reads its answer; no I/O.
 *
 * The writer reads the transcript as numbered segment lines and names moments by SEGMENT INDEX;
 * code maps indexes to times. The writer is trusted: no retry, no length check. Only a moment
 * naming a segment that does not exist is dropped.
 */
import { buildCampaignBriefDirective } from "../campaign-brief.js";
import { ReelsError } from "./errors.js";
import { segmentLines, spanOfSegments, type Transcript } from "./transcript.js";

export const MOMENTS_DEFAULTS = { count: 5, minSeconds: 20, maxSeconds: 60 } as const;

export interface MomentsParams { count?: number; minSeconds?: number; maxSeconds?: number; brief?: string | null }

/** The shape every reels LLM step hands a script: the /complete body minus provider + model (same keys as buildThreadRequest). */
export interface ReelsChatRequest {
  message: string;
  systemPrompt: string;
  responseFormat: "json";
  responseSchema: object;
  strictResponseSchema: object;
  maxTokens: number;
}

export function chatRequest(systemPrompt: string, message: string, properties: Record<string, unknown>, required: string[], maxTokens: number): ReelsChatRequest {
  const schema = { type: "object", properties, required };
  return { message, systemPrompt, responseFormat: "json", responseSchema: schema, strictResponseSchema: strictOf(schema), maxTokens };
}

/** `additionalProperties: false` on every object level (Anthropic's structured output 400s without it). */
function strictOf(schema: unknown): object {
  if (Array.isArray(schema)) return schema.map(strictOf);
  if (!schema || typeof schema !== "object") return schema as object;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = v && typeof v === "object" ? strictOf(v) : v;
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

const MOMENT_PROPERTIES = {
  moments: {
    type: "array",
    description: "The moments, strongest first.",
    items: {
      type: "object",
      properties: {
        startSegment: { type: "integer", description: "Index of the moment's first segment, as numbered in the transcript." },
        endSegment: { type: "integer", description: "Index of the moment's last segment (included)." },
        title: { type: "string", description: "A few words naming the moment." },
        why: { type: "string", description: "One sentence: why a stranger keeps watching this." },
        quote: { type: "string", description: "The strongest sentence of the moment, verbatim from the transcript." },
      },
      required: ["startSegment", "endSegment", "title", "why", "quote"],
    },
  },
};

export function buildMomentsRequest(transcript: Transcript, params: MomentsParams = {}): ReelsChatRequest {
  const count = params.count ?? MOMENTS_DEFAULTS.count;
  const min = params.minSeconds ?? MOMENTS_DEFAULTS.minSeconds;
  const max = params.maxSeconds ?? MOMENTS_DEFAULTS.maxSeconds;
  const brief = buildCampaignBriefDirective(params.brief);
  const systemPrompt = [
    "You pick the moments of a long recorded conversation that will be cut into short vertical videos (Reels, Shorts, TikTok).",
    "",
    "THE GAME: each clip is shown to strangers who are scrolling, with no context and no patience. A clip works when:",
    "- it carries ONE self-contained idea: someone who never saw the rest understands it and gets something from it;",
    "- its first sentence is strong: a claim, a number, a question, a confession, the start of a story. Never a moment that opens on small talk, a greeting, or an answer whose question is missing;",
    "- it holds an emotional or surprising beat: a result, a mistake, a strong opinion, a turn in a story, a laugh;",
    "- it ends on a complete thought, right after the point lands. Never mid-sentence, never trailing into the next subject.",
    "",
    `Pick the ${count} strongest moment${count === 1 ? "" : "s"} of the transcript below. Each one lasts between ${min} and ${max} seconds (the timestamps on each line tell you). Moments do not overlap. If the recording holds fewer moments that good, answer fewer.`,
    "",
    "The transcript is one numbered segment per line: [index] start-end text. Name each moment by the index of its first and last segment (both included); choose the boundaries so the clip starts on its strong first sentence and stops when the thought is complete.",
    ...(brief ? [brief] : []),
    "",
    "OUTPUT: answer with the JSON object only: moments, strongest first, each with startSegment, endSegment, title (a few words), why (one sentence: why a stranger keeps watching), quote (its strongest sentence, verbatim).",
  ].join("\n");
  return chatRequest(systemPrompt, segmentLines(transcript), MOMENT_PROPERTIES, ["moments"], 8000);
}

export interface Moment { start: number; end: number; durationSeconds: number; title: string; why: string; quote: string }

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The moments read off the answer's `json`. Throws NO_MOMENTS (502) when none is usable. */
export function readMomentsAnswer(json: unknown, transcript: Transcript, log: (message: string) => void = () => {}): Moment[] {
  const list = (json && typeof json === "object" && Array.isArray((json as { moments?: unknown }).moments) ? (json as { moments: unknown[] }).moments : []) as Array<Record<string, unknown>>;
  const moments: Moment[] = [];
  for (const m of list) {
    const span = m && typeof m === "object" ? spanOfSegments(transcript, Number(m.startSegment), Number(m.endSegment)) : null;
    if (!span) {
      log(`moment dropped: segments ${JSON.stringify(m?.startSegment)}..${JSON.stringify(m?.endSegment)} do not exist (transcript has ${transcript.segments.length})`);
      continue;
    }
    moments.push({ ...span, durationSeconds: Math.round((span.end - span.start) * 1000) / 1000, title: text(m.title), why: text(m.why), quote: text(m.quote) });
  }
  if (!moments.length) {
    throw new ReelsError("NO_MOMENTS", `The model answered no usable moment (${list.length} answered, none naming existing segments)`, 502);
  }
  return moments;
}
