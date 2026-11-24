/**
 * A finished clip's contract (REELS-1124): h264, yuv420p, 1080x1920, an audio track, the
 * expected duration, faststart. Pure over the probe result; a miss is OUTPUT_INVALID and the
 * file is never published.
 */
import type { ProbedVideo } from "../debrief/ffmpeg.js";
import { ReelsError } from "./errors.js";
import { OUT_HEIGHT, OUT_WIDTH } from "./layouts.js";

export const CUT_TOLERANCE_SECONDS = 0.2;
export const JOIN_TOLERANCE_SECONDS = 0.3;

export function assertClipDeliverable(p: ProbedVideo, expectedSeconds: number, toleranceSeconds: number, faststart: boolean): void {
  const problems: string[] = [];
  if (!p.video) problems.push("no video stream");
  else {
    if (p.video.codec !== "h264") problems.push(`video codec ${p.video.codec}, want h264`);
    if (p.video.pixFmt !== "yuv420p") problems.push(`pixel format ${p.video.pixFmt}, want yuv420p`);
    if (p.video.width !== OUT_WIDTH || p.video.height !== OUT_HEIGHT) problems.push(`size ${p.video.width}x${p.video.height}, want ${OUT_WIDTH}x${OUT_HEIGHT}`);
  }
  if (!p.audio) problems.push("no audio stream");
  if (!(Math.abs(p.durationSeconds - expectedSeconds) <= toleranceSeconds)) {
    problems.push(`duration ${Number(p.durationSeconds).toFixed(3)}s, expected ${expectedSeconds.toFixed(3)}s ± ${toleranceSeconds}`);
  }
  if (!faststart) problems.push("moov atom after mdat (not faststart)");
  if (problems.length) throw new ReelsError("OUTPUT_INVALID", `Rendered clip failed its checks: ${problems.join("; ")}`);
}
