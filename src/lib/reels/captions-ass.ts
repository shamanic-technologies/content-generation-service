/**
 * The ASS subtitle files burned into a clip (REELS-1124). Pure leaf: strings in, a string out.
 *
 * Captions: groups of ≤3 words / ≤18 characters, uppercase, bold white with a thick black
 * outline, centered in the lower third (y=1350: above Instagram's caption and buttons). The word
 * being spoken is yellow: ONE EVENT PER WORD STATE (the whole group redrawn with another word
 * highlighted), never \k tags, so every libass draws the same. A group stays up from its first
 * word's start to its last word's end, extended to the next group when the gap is under 0.3 s
 * (no flicker).
 *
 * Hook line: dark text on a white box (BorderStyle 3), upper third (y=420), wrapped to ≤16
 * characters per line, fading out over 200 ms.
 *
 * The script resolution is the output's (1080x1920), so positions are output pixels.
 */
import { stripDashes } from "../dashes.js";

export const FONT_NAME = "Montserrat ExtraBold";
export const CAPTION_MAX_WORDS = 3;
export const CAPTION_MAX_CHARS = 18;
export const CAPTION_JOIN_GAP_SECONDS = 0.3;
export const CAPTION_Y = 1350;
export const HOOK_Y = 420;
export const HOOK_MAX_LINE_CHARS = 16;
export const HOOK_FADE_OUT_MS = 200;

const CAPTION_FONT_SIZE = 100; // 18 uppercase characters span about 780 px of the 1080
const HOOK_FONT_SIZE = 120; // 16 characters span about 650 px with the box padding
const WHITE = "&H00FFFFFF";
const YELLOW = "&H0000E6FF"; // ASS is BGR: #FFE600
/** A pause this long starts a new group even when the current one has room. */
const GROUP_BREAK_GAP_SECONDS = 0.7;

export interface TimedWord { start: number; end: number; word: string }
export interface CaptionGroup { start: number; end: number; words: TimedWord[] }

/** Text as libass must read it literally: no override block, no escape, no line break. */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "⧵") // REVERSE SOLIDUS OPERATOR: a backslash would start an ASS escape (\N, \h)
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** `H:MM:SS.cc` (centiseconds, the format's resolution). */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** A word as drawn: dashes stripped, escaped, uppercase. "" = nothing to draw. */
export function captionWord(word: string): string {
  const drawn = escapeAssText(stripDashes(word)).replace(/^[\s,]+/, "").trim().toUpperCase();
  // A token with no letter or digit (a lone dash, stray punctuation) draws nothing.
  return /[\p{L}\p{N}]/u.test(drawn) ? drawn : "";
}

/**
 * Groups of ≤ CAPTION_MAX_WORDS words and ≤ CAPTION_MAX_CHARS characters (a single longer word
 * stands alone). A sentence end or a pause starts a new group. `end` already holds the extension
 * to the next group's start when the gap is under CAPTION_JOIN_GAP_SECONDS.
 */
export function groupCaptionWords(words: TimedWord[]): CaptionGroup[] {
  const drawn = words
    .map((w) => ({ start: w.start, end: Math.max(w.end, w.start), word: captionWord(w.word) }))
    .filter((w) => w.word !== "")
    .sort((a, b) => a.start - b.start);
  const groups: CaptionGroup[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (cur.length) groups.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  for (const w of drawn) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const joined = cur.map((c) => c.word).join(" ").length + 1 + w.word.length;
      if (cur.length >= CAPTION_MAX_WORDS || joined > CAPTION_MAX_CHARS || w.start - prev.end > GROUP_BREAK_GAP_SECONDS || /[.!?]$/.test(prev.word)) flush();
    }
    cur.push(w);
  }
  flush();
  groups.forEach((g, i) => {
    const next = groups[i + 1];
    if (next && next.start - g.end < CAPTION_JOIN_GAP_SECONDS) g.end = Math.max(next.start, g.start);
  });
  return groups;
}

function header(styles: string[]): string[] {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
}

const CAPTION_STYLE = `Style: Caption,${FONT_NAME},${CAPTION_FONT_SIZE},${WHITE},${WHITE},&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,9,2,5,40,40,40,1`;
const HOOK_STYLE = `Style: Hook,${FONT_NAME},${HOOK_FONT_SIZE},&H00141414,&H00141414,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,20,0,5,60,60,60,1`;

/**
 * The captions of one cut. `words` are timed RELATIVE TO THE CUT (0 = its first frame); events
 * are clamped to [0, durationSeconds].
 */
export function buildCaptionsAss(words: TimedWord[], durationSeconds: number): string {
  const lines = header([CAPTION_STYLE]);
  const clamp = (s: number) => Math.min(Math.max(s, 0), durationSeconds);
  for (const g of groupCaptionWords(words)) {
    const chars = g.words.map((w) => w.word).join(" ").length;
    // A lone word longer than the line budget is drawn smaller rather than cut off.
    const size = chars > CAPTION_MAX_CHARS ? `\\fs${Math.floor((CAPTION_FONT_SIZE * CAPTION_MAX_CHARS) / chars)}` : "";
    g.words.forEach((w, i) => {
      const from = clamp(i === 0 ? g.start : w.start);
      const to = clamp(i < g.words.length - 1 ? g.words[i + 1].start : g.end);
      if (to - from < 0.01) return;
      const text = g.words.map((x, j) => (j === i ? `{\\c${YELLOW}&}${x.word}{\\c${WHITE}&}` : x.word)).join(" ");
      lines.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Caption,,0,0,0,,{\\an5\\pos(540,${CAPTION_Y})${size}}${text}`);
    });
  }
  return lines.join("\n") + "\n";
}

/** Greedy wrap to ≤ maxChars per line; a longer word stands alone on its line. */
export function wrapLine(text: string, maxChars = HOOK_MAX_LINE_CHARS): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > maxChars) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The line as shown on screen: dashes stripped, one line, trimmed. */
export function cleanHookLine(text: string): string {
  return stripDashes(text.replace(/\s+/g, " ").trim()).replace(/\s+/g, " ").trim();
}

/** The hook line overlaid for the first `seconds` of a clip. */
export function buildHookAss(text: string, seconds: number): string {
  const lines = header([HOOK_STYLE]);
  const wrapped = wrapLine(cleanHookLine(text)).map(escapeAssText).filter(Boolean);
  // More than 4 lines would run into the speaker's face: draw smaller instead.
  const size = wrapped.length > 4 ? `\\fs${Math.floor((HOOK_FONT_SIZE * 4) / wrapped.length)}` : "";
  lines.push(`Dialogue: 1,${assTime(0)},${assTime(seconds)},Hook,,0,0,0,,{\\an5\\pos(540,${HOOK_Y})\\fad(0,${HOOK_FADE_OUT_MS})${size}}${wrapped.join("\\N")}`);
  return lines.join("\n") + "\n";
}
