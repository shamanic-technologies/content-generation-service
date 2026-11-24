/**
 * The transcript of a source video, in ONE shape whatever the transcriber answered (REELS-1124).
 * Pure leaf: no I/O, no db.
 *
 * `normalizeTranscript` accepts:
 *  - word-level input: `segments[].words[]` (whisper / mlx-whisper: `{ start, end, word }`) or a
 *    top-level `words[]` (`word` or `text`) → `wordTimestamps: "model"`; times spelled `start`/`end`
 *    (whisper) or `startSeconds`/`endSeconds` (chat-service's media transcriptions);
 *  - segment-level only: `segments[] { start, end, text }` → each segment's words are spread over
 *    its span proportionally to their length → `wordTimestamps: "interpolated"`.
 * Times are seconds from the start of the source.
 */

export interface TranscriptSegment { index: number; start: number; end: number; text: string }
export interface TranscriptWord { start: number; end: number; word: string }
export interface Transcript {
  language: string | null;
  text: string;
  wordTimestamps: "model" | "interpolated";
  segments: TranscriptSegment[];
  words: TranscriptWord[];
}

export class TranscriptUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptUnreadableError";
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const round = (s: number) => Math.round(s * 1000) / 1000;

function readWord(raw: unknown): TranscriptWord | null {
  const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = String(w.word ?? w.text ?? "").trim();
  const start = num(w.start ?? w.startSeconds);
  const end = num(w.end ?? w.endSeconds);
  if (!text || start === null || end === null) return null;
  return { start: round(start), end: round(Math.max(end, start)), word: text };
}

/** A segment's words spread over its span, each weighted by its length (+1 for the space). */
export function interpolateWords(start: number, end: number, text: string): TranscriptWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((n, t) => n + t.length + 1, 0);
  if (!tokens.length || total === 0) return [];
  const span = Math.max(0, end - start);
  let at = 0;
  return tokens.map((word) => {
    const from = start + (span * at) / total;
    at += word.length + 1;
    return { start: round(from), end: round(start + (span * at) / total), word };
  });
}

export function normalizeTranscript(raw: unknown): Transcript {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawSegments = Array.isArray(data.segments) ? (data.segments as unknown[]) : [];
  const topWords = (Array.isArray(data.words) ? (data.words as unknown[]) : []).map(readWord).filter((w): w is TranscriptWord => w !== null);

  const segments: TranscriptSegment[] = [];
  const segmentWords: TranscriptWord[][] = [];
  for (const rs of rawSegments) {
    const s = (rs && typeof rs === "object" ? rs : {}) as Record<string, unknown>;
    const text = String(s.text ?? "").replace(/\s+/g, " ").trim();
    const start = num(s.start ?? s.startSeconds);
    const end = num(s.end ?? s.endSeconds);
    if (!text || start === null || end === null) continue;
    segments.push({ index: segments.length, start: round(start), end: round(Math.max(end, start)), text });
    segmentWords.push((Array.isArray(s.words) ? (s.words as unknown[]) : []).map(readWord).filter((w): w is TranscriptWord => w !== null));
  }

  let words: TranscriptWord[];
  let wordTimestamps: Transcript["wordTimestamps"];
  if (segments.length && segmentWords.every((w) => w.length > 0)) {
    words = segmentWords.flat();
    wordTimestamps = "model";
  } else if (topWords.length) {
    words = topWords;
    wordTimestamps = "model";
  } else if (segments.length) {
    words = segments.flatMap((s) => interpolateWords(s.start, s.end, s.text));
    wordTimestamps = "interpolated";
  } else {
    throw new TranscriptUnreadableError("the transcription carries no segment and no word with a start and an end");
  }
  words.sort((a, b) => a.start - b.start);

  // Word-level input without segments: sentence-ish segments so the moments prompt has lines to name.
  const finalSegments = segments.length ? segments : segmentsFromWords(words);
  const language = typeof data.language === "string" && data.language.trim() ? data.language.trim() : null;
  const text = typeof data.text === "string" && data.text.trim() ? data.text.replace(/\s+/g, " ").trim() : finalSegments.map((s) => s.text).join(" ");
  return { language, text, wordTimestamps, segments: finalSegments, words };
}

/** Segments cut at sentence ends, a pause over 1 s, or 30 words. */
function segmentsFromWords(words: TranscriptWord[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ index: out.length, start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.word).join(" ") });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (/[.!?]$/.test(w.word) || cur.length >= 30 || (next && next.start - w.end > 1)) flush();
  });
  flush();
  return out;
}

/** The words spoken inside [start, end): a word belongs to the span holding its midpoint. */
export function wordsInSpan(t: Pick<Transcript, "words">, start: number, end: number): TranscriptWord[] {
  return t.words.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return mid >= start && mid < end;
  });
}

export function textOfSpan(t: Pick<Transcript, "words">, start: number, end: number): string {
  return wordsInSpan(t, start, end).map((w) => w.word).join(" ");
}

/** `mm:ss.d` (minutes run past 59: a 2 h video reads 119:59.9). */
export function clock(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths % 10}`;
}

/** The transcript as the moments writer reads it: `[12] 03:41.2-03:47.9 text`, one segment per line. */
export function segmentLines(t: Pick<Transcript, "segments">): string {
  return t.segments.map((s) => `[${s.index}] ${clock(s.start)}-${clock(s.end)} ${s.text}`).join("\n");
}

/**
 * The source span of segments startIndex..endIndex: from the first segment's first word to the
 * last segment's last word (the segment's own bounds when it holds no word). null = an index
 * that does not exist, or an inverted range.
 */
export function spanOfSegments(t: Transcript, startIndex: number, endIndex: number): { start: number; end: number } | null {
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex > endIndex) return null;
  const first = t.segments[startIndex];
  const last = t.segments[endIndex];
  if (!first || !last) return null;
  const firstWords = wordsInSpan(t, first.start, first.end);
  const lastWords = wordsInSpan(t, last.start, last.end);
  const start = firstWords.length ? Math.min(firstWords[0].start, first.start) : first.start;
  const end = lastWords.length ? Math.max(lastWords[lastWords.length - 1].end, last.end) : last.end;
  return end > start ? { start: round(start), end: round(end) } : null;
}
