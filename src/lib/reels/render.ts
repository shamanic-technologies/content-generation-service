/**
 * The three renders of a clip (REELS-1124), each ONE ffmpeg run at nice 10 (debrief's `run`),
 * each checked with ffprobe before it returns. Files in, a file out: no db, no HTTP, so
 * scripts/reels-local.ts and the ffmpeg test call exactly what the job queue calls.
 *
 *  - renderCut: a span of the SOURCE → 1080x1920 with burned captions.
 *  - renderInternalHook: a short span of the SOURCE (same layout, its own captions) joined in
 *    front of the parent clip's file.
 *  - renderExternalHook: the parent clip's file with a text line over its first seconds.
 *
 * `-ss` sits BEFORE `-i` (fast seek in a 2 GB file; frame-accurate since the stream is
 * re-encoded), so every caption time is relative to the cut.
 */
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFaststart, probeVideo, run } from "../debrief/ffmpeg.js";
import { SAFE_VIDEO_INPUT_OPTIONS } from "../ffmpeg-input.js";
import { buildCaptionsAss, buildHookAss, type TimedWord } from "./captions-ass.js";
import { ReelsError } from "./errors.js";
import { audioGraph, layoutGraph, subtitlesFilter, OUT_FPS, type ClipLayout } from "./layouts.js";
import { FONTS_DIR } from "./media.js";
import { assertClipDeliverable, CUT_TOLERANCE_SECONDS, JOIN_TOLERANCE_SECONDS } from "./output-check.js";

const ENCODE = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(OUT_FPS),
  "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
  "-movflags", "+faststart",
];

export interface RenderedClip { path: string; durationSeconds: number }

/** Words of the source inside [start, end), re-timed to the cut (0 = its first frame). */
export function relativeWords(words: TimedWord[], start: number, end: number): TimedWord[] {
  return words
    .filter((w) => {
      const mid = (w.start + w.end) / 2;
      return mid >= start && mid < end;
    })
    .map((w) => ({ word: w.word, start: Math.max(0, w.start - start), end: Math.min(end - start, w.end - start) }));
}

async function withWorkDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "reels-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ffmpeg(args: string[], what: string): Promise<void> {
  try {
    await run("ffmpeg", ["-v", "error", "-y", ...args]);
  } catch (err) {
    throw new ReelsError("RENDER_FAILED", `${what}: ${(err as Error).message}`);
  }
}

async function check(path: string, expectedSeconds: number, tolerance: number): Promise<RenderedClip> {
  const fh = await open(path, "r");
  const head = Buffer.alloc(65536);
  try {
    await fh.read(head, 0, head.length, 0);
  } finally {
    await fh.close();
  }
  const probed = await probeVideo(path);
  assertClipDeliverable(probed, expectedSeconds, tolerance, isFaststart(head));
  return { path, durationSeconds: probed.durationSeconds };
}

/** Input args of a span of the source; a source with no audio track gets silence as input 1. */
function sourceSpan(sourcePath: string, start: number, seconds: number, hasAudio: boolean): { args: string[]; audioPad: string; inputs: number } {
  // The source's bytes are the caller's: local file + media demuxers only (SSRF-1127).
  const args = ["-ss", start.toFixed(3), "-t", seconds.toFixed(3), ...SAFE_VIDEO_INPUT_OPTIONS, "-i", sourcePath];
  if (hasAudio) return { args, audioPad: "0:a:0", inputs: 1 };
  return { args: [...args, "-f", "lavfi", "-t", seconds.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo"], audioPad: "1:a:0", inputs: 2 };
}

export interface CutParams {
  sourcePath: string;
  sourceHasAudio?: boolean;
  start: number;
  end: number;
  layout: ClipLayout;
  cropX?: number;
  /** The SOURCE's words (source seconds); null = no captions. Only those inside the span are drawn. */
  words: TimedWord[] | null;
  outPath: string;
}

export async function renderCut(p: CutParams): Promise<RenderedClip> {
  const seconds = p.end - p.start;
  return withWorkDir(async (dir) => {
    const subtitles: string[] = [];
    if (p.words) {
      const ass = join(dir, "captions.ass");
      await writeFile(ass, buildCaptionsAss(relativeWords(p.words, p.start, p.end), seconds));
      subtitles.push(subtitlesFilter(ass, FONTS_DIR));
    }
    const src = sourceSpan(p.sourcePath, p.start, seconds, p.sourceHasAudio !== false);
    const graph = [
      layoutGraph({ layout: p.layout, cropX: p.cropX, in: "0:v:0", out: "v", subtitles }),
      audioGraph({ in: src.audioPad, out: "a", durationSeconds: seconds }),
    ].join(";");
    await ffmpeg([...src.args, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", ...ENCODE, "-t", seconds.toFixed(3), p.outPath], "Rendering the cut");
    return check(p.outPath, seconds, CUT_TOLERANCE_SECONDS);
  });
}

export interface InternalHookParams {
  sourcePath: string;
  sourceHasAudio?: boolean;
  /** The hook's span in the source. */
  hookStart: number;
  hookEnd: number;
  layout: ClipLayout;
  cropX?: number;
  words: TimedWord[] | null;
  /** The parent clip's rendered file and its probed duration. */
  parentPath: string;
  parentSeconds: number;
  outPath: string;
}

export async function renderInternalHook(p: InternalHookParams): Promise<RenderedClip> {
  const hookSeconds = p.hookEnd - p.hookStart;
  return withWorkDir(async (dir) => {
    const subtitles: string[] = [];
    if (p.words) {
      const ass = join(dir, "hook-captions.ass");
      await writeFile(ass, buildCaptionsAss(relativeWords(p.words, p.hookStart, p.hookEnd), hookSeconds));
      subtitles.push(subtitlesFilter(ass, FONTS_DIR));
    }
    const src = sourceSpan(p.sourcePath, p.hookStart, hookSeconds, p.sourceHasAudio !== false);
    const parent = src.inputs; // index of the parent clip among the inputs
    const graph = [
      layoutGraph({ layout: p.layout, cropX: p.cropX, in: "0:v:0", out: "hv", subtitles }),
      // 30 ms fades on both sides of the join: a hard audio cut pops.
      audioGraph({ in: src.audioPad, out: "ha", durationSeconds: hookSeconds, fadeIn: true, fadeOut: true }),
      `[${parent}:v:0]setsar=1,fps=${OUT_FPS},format=yuv420p[pv]`,
      audioGraph({ in: `${parent}:a:0`, out: "pa", durationSeconds: p.parentSeconds, fadeIn: true }),
      "[hv][ha][pv][pa]concat=n=2:v=1:a=1[v][a]",
    ].join(";");
    await ffmpeg([...src.args, "-i", p.parentPath, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", ...ENCODE, p.outPath], "Joining the hook and the clip");
    return check(p.outPath, hookSeconds + p.parentSeconds, JOIN_TOLERANCE_SECONDS);
  });
}

export interface ExternalHookParams {
  parentPath: string;
  parentSeconds: number;
  /** The line shown on screen. */
  text: string;
  /** How long it stays. */
  seconds: number;
  outPath: string;
}

export async function renderExternalHook(p: ExternalHookParams): Promise<RenderedClip> {
  return withWorkDir(async (dir) => {
    const ass = join(dir, "hook.ass");
    await writeFile(ass, buildHookAss(p.text, Math.min(p.seconds, p.parentSeconds)));
    const graph = `[0:v:0]setsar=1,fps=${OUT_FPS},format=yuv420p,${subtitlesFilter(ass, FONTS_DIR)}[v]`;
    // The audio is copied untouched: nothing about it changes, so nothing can pop or drift.
    await ffmpeg(
      ["-i", p.parentPath, "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(OUT_FPS),
        "-c:a", "copy", "-movflags", "+faststart", p.outPath],
      "Overlaying the hook line",
    );
    return check(p.outPath, p.parentSeconds, CUT_TOLERANCE_SECONDS);
  });
}
