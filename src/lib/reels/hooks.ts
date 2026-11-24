/**
 * The two hook mechanics of a clip (REELS-1124). Pure leaf: builds each chat-service request and
 * reads its answer; no I/O. Two mechanics so two scripts can compete on « Hook added »:
 *  - internal: the juiciest seconds of the clip itself, copied in front of it;
 *  - external: a line proven elsewhere (the hook library), overlaid as text on its first seconds.
 * The writer is trusted: no retry, no length check. An answer naming words or a library hook
 * that do not exist is HOOK_UNREADABLE (502).
 */
import { createHash } from "node:crypto";
import { buildCampaignBriefDirective } from "../campaign-brief.js";
import { cleanHookLine } from "./captions-ass.js";
import { ReelsError } from "./errors.js";
import { chatRequest, type ReelsChatRequest } from "./moments.js";
import type { TranscriptWord } from "./transcript.js";

export const HOOK_SECONDS = { default: 3, min: 1, max: 6 } as const;
/** How many library hooks one prompt shows. */
export const HOOK_PROMPT_SAMPLE = 150;
export const HOOK_PROMPT_TEMPLATES = 100;
export const TEMPLATE_SOURCE = "viral-hooks-skill";

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// ---------------------------------------------------------------------------
// Internal hook
// ---------------------------------------------------------------------------

/** The clip's words as the writer reads them: `index|seconds from the clip's start|word`. */
export function wordLines(words: TranscriptWord[], clipStart: number): string {
  return words.map((w, i) => `${i}|${Math.max(0, w.start - clipStart).toFixed(1)}|${w.word}`).join("\n");
}

export function buildInternalHookRequest(words: TranscriptWord[], clipStart: number, params: { maxSeconds?: number; brief?: string | null } = {}): ReelsChatRequest {
  const max = params.maxSeconds ?? HOOK_SECONDS.default;
  const brief = buildCampaignBriefDirective(params.brief);
  const systemPrompt = [
    "You choose the HOOK of a short vertical video: a few seconds taken from the clip itself and played FIRST, before the clip starts from its beginning.",
    "",
    "THE GAME: a stranger is scrolling and gives a video about one second. The hook is what makes them stop: they hear the most striking thing the clip contains, and stay to find out how the speaker gets there.",
    `- Pick between 1.5 and ${max} seconds of consecutive words.`,
    "- Pick the boldest claim, the most surprising or the most emotional phrase of the clip: a number, a strong opinion, a confession, a punchline.",
    "- It must be a complete phrase that makes sense heard alone: start on the first word of the phrase, end on its last. Never cut inside a word group that belongs together.",
    "- Prefer a phrase that comes later than the clip's first 5 seconds: the hook teases what is coming, it should not repeat what the viewer hears right after it.",
    "",
    "The clip is one word per line: index|seconds from the clip's start|word. Name the hook by the index of its first and last word (both included).",
    ...(brief ? [brief] : []),
    "",
    "OUTPUT: answer with the JSON object only: startWord, endWord, quote (those words verbatim), why (one sentence: why this stops the scroll).",
  ].join("\n");
  return chatRequest(
    systemPrompt,
    wordLines(words, clipStart),
    {
      startWord: { type: "integer", description: "Index of the hook's first word." },
      endWord: { type: "integer", description: "Index of the hook's last word (included)." },
      quote: { type: "string", description: "The hook's words, verbatim." },
      why: { type: "string", description: "One sentence: why this stops the scroll." },
    },
    ["startWord", "endWord", "quote", "why"],
    2000,
  );
}

export interface InternalHookChoice { start: number; end: number; quote: string; why: string }

/** The source span of the chosen words. `words` = the same list the request was built from. */
export function readInternalHookAnswer(json: unknown, words: TranscriptWord[]): InternalHookChoice {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const a = Number(j.startWord);
  const b = Number(j.endWord);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b >= words.length || a > b) {
    throw new ReelsError("HOOK_UNREADABLE", `The model named words ${JSON.stringify(j.startWord)}..${JSON.stringify(j.endWord)}; the clip has words 0..${words.length - 1}`, 502);
  }
  const start = words[a].start;
  const end = words[b].end;
  if (!(end > start)) throw new ReelsError("HOOK_UNREADABLE", `The model's words ${a}..${b} span no time`, 502);
  return { start, end, quote: words.slice(a, b + 1).map((w) => w.word).join(" "), why: text(j.why) };
}

// ---------------------------------------------------------------------------
// External hook
// ---------------------------------------------------------------------------

export interface LibraryHook {
  id: string;
  source: string;
  sourceUrl: string;
  category: string | null;
  template: string;
  evidence: Record<string, unknown> | null;
}

const viewsOf = (h: LibraryHook): number | null => (typeof h.evidence?.views === "number" ? (h.evidence.views as number) : null);

/**
 * The hooks one prompt shows when the library is larger than HOOK_PROMPT_SAMPLE: every fill-in
 * template (up to HOOK_PROMPT_TEMPLATES) + verbatim hooks picked deterministically by the clip id
 * among the most viewed, so a clip always sees the same sample and two clips see different ones.
 */
export function sampleHooks(hooks: LibraryHook[], seed: string, size = HOOK_PROMPT_SAMPLE): LibraryHook[] {
  const byId = (a: LibraryHook, b: LibraryHook) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const templates = hooks.filter((h) => h.source === TEMPLATE_SOURCE).sort(byId).slice(0, Math.min(HOOK_PROMPT_TEMPLATES, size));
  const rank = (h: LibraryHook) => createHash("sha1").update(`${seed}:${h.id}`).digest("hex");
  const verbatim = hooks
    .filter((h) => h.source !== TEMPLATE_SOURCE)
    .map((h) => ({ h, r: rank(h) }))
    .sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0))
    .slice(0, Math.max(0, size - templates.length))
    .map((x) => x.h)
    .sort((a, b) => (viewsOf(b) ?? 0) - (viewsOf(a) ?? 0) || byId(a, b));
  return [...templates, ...verbatim];
}

export function hookLine(h: LibraryHook): string {
  const views = viewsOf(h);
  return `${h.id} | ${h.template.replace(/\s+/g, " ").replace(/\|/g, "/")}${views !== null ? ` | ${views} views` : ""}`;
}

export function buildExternalHookRequest(clipText: string, shown: LibraryHook[], params: { brief?: string | null } = {}): ReelsChatRequest {
  const brief = buildCampaignBriefDirective(params.brief);
  const systemPrompt = [
    "You write the HOOK LINE of a short vertical video: one line of text shown on screen during its first seconds, on top of the video.",
    "",
    "THE GAME: a stranger is scrolling and gives a video about one second. The line is what makes them stop and listen. The lines below already did that on other videos; your job is to reuse ONE of them for this clip.",
    "- Read what the clip actually says and delivers. Pick the ONE line from the library that fits it best.",
    "- A line with [blanks] is a template: fill each blank from the clip. A line without blanks is a hook that worked verbatim on another video: adapt it to this clip, keeping its structure and rhythm.",
    "- The line must be TRUE to the clip: promise only what the clip delivers. Never invent a number, a result or a claim the speaker does not make.",
    "- At most 10 words. No hashtag, no emoji, no quotation marks, no brackets left.",
    "- Write it in the language the clip is spoken in.",
    "",
    "THE LIBRARY, one line each: id | line | views of the video it ran on, when known:",
    ...shown.map(hookLine),
    ...(brief ? [brief] : []),
    "",
    "OUTPUT: answer with the JSON object only: hookId (the id of the library line you used), text (the line as shown on screen), why (one sentence: why this line fits this clip).",
  ].join("\n");
  return chatRequest(
    systemPrompt,
    clipText,
    {
      hookId: { type: "string", description: "The id of the library line used." },
      text: { type: "string", description: "The line as shown on screen, at most 10 words." },
      why: { type: "string", description: "One sentence: why this line fits this clip." },
    },
    ["hookId", "text", "why"],
    2000,
  );
}

export interface ExternalHookChoice { hook: LibraryHook; text: string; why: string }

/** `find` looks a hook id up in the library (active or not: an old clip names old rows). */
export function readExternalHookAnswer(json: unknown, find: (id: string) => LibraryHook | undefined): ExternalHookChoice {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const id = text(j.hookId);
  const hook = id ? find(id) : undefined;
  if (!hook) throw new ReelsError("HOOK_UNREADABLE", `The model named hook ${JSON.stringify(j.hookId)}, which is not in the library`, 502);
  const line = cleanHookLine(text(j.text));
  if (!line) throw new ReelsError("HOOK_UNREADABLE", "The model answered no hook line", 502);
  return { hook, text: line, why: text(j.why) };
}
