/**
 * The finished file's contract (AC: h264, yuv420p, an audio track, duration =
 * the scene's sum of screen times, faststart). Pure over the probe result so the
 * rule is unit-tested; a miss is OUTPUT_INVALID, never an upload.
 */
import { DebriefError } from "./errors.js";
import type { ProbedVideo } from "./ffmpeg.js";

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1350; // 4:5
/** One frame at 30 fps plus AAC priming slack. */
export const DURATION_TOLERANCE_SECONDS = 0.1;

export function assertDeliverable(p: ProbedVideo, sceneSeconds: number, faststart: boolean): void {
  const problems: string[] = [];
  if (!p.video) problems.push("no video stream");
  else {
    if (p.video.codec !== "h264") problems.push(`video codec ${p.video.codec}, want h264`);
    if (p.video.pixFmt !== "yuv420p") problems.push(`pixel format ${p.video.pixFmt}, want yuv420p`);
    if (p.video.width !== VIDEO_WIDTH || p.video.height !== VIDEO_HEIGHT) {
      problems.push(`size ${p.video.width}x${p.video.height}, want ${VIDEO_WIDTH}x${VIDEO_HEIGHT}`);
    }
  }
  if (!p.audio) problems.push("no audio stream");
  if (!(Math.abs(p.durationSeconds - sceneSeconds) <= DURATION_TOLERANCE_SECONDS)) {
    problems.push(`duration ${p.durationSeconds.toFixed(3)}s, scene is ${sceneSeconds.toFixed(3)}s`);
  }
  if (!faststart) problems.push("moov atom after mdat (not faststart)");
  if (problems.length) throw new DebriefError("OUTPUT_INVALID", `Rendered MP4 failed its checks: ${problems.join("; ")}`);
}
