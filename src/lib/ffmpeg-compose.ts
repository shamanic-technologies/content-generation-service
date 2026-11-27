import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SAFE_VIDEO_INPUT_OPTIONS } from "./ffmpeg-input.js";

const execFileAsync = promisify(execFile);

interface ComposeOptions {
  /** Raw video file bytes */
  videoBuffer: Buffer;
  /** PNG image bytes for the top panel */
  imageBuffer: Buffer;
  /** Layout: "quote-top" (default) = quote 40% top + webcam 60% bottom; "webcam-top" = webcam 50% top + quote 50% bottom */
  layout?: "quote-top" | "webcam-top";
}

/**
 * Compose a split-screen vertical video (1080x1920):
 *   - Top 40% (768px): static quote image
 *   - Bottom 60% (1152px): webcam video (scaled + cropped)
 * Returns the composed MP4 buffer.
 */
export async function composeSplitScreen(opts: ComposeOptions): Promise<Buffer> {
  const { videoBuffer, imageBuffer, layout = "quote-top" } = opts;
  const tmp = await mkdtemp(join(tmpdir(), "compose-"));

  // The caller's bytes: no extension (never a hint from the caller's URL), demuxer chosen by
  // content among SAFE_VIDEO_DEMUXERS only, local file protocol only (SSRF-1127).
  const videoPath = join(tmp, "input.bin");
  const imagePath = join(tmp, "quote.png");
  const outputPath = join(tmp, "output.mp4");

  try {
    await Promise.all([
      writeFile(videoPath, videoBuffer),
      writeFile(imagePath, imageBuffer),
    ]);

    // FFmpeg filter: stack quote image + webcam vertically → 1080x1920
    // "quote-top" (default): quote 768px top (40%) + webcam 1152px bottom (60%)
    // "webcam-top": webcam 960px top (50%) + quote 960px bottom (50%)
    const filterComplex = layout === "webcam-top"
      ? [
          "[0:v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[top]",
          "[1:v]scale=1080:960:force_original_aspect_ratio=disable[bot]",
          "[top][bot]vstack=inputs=2[out]",
        ].join(";")
      : [
          "[1:v]scale=1080:768:force_original_aspect_ratio=disable[top]",
          "[0:v]scale=1080:1152:force_original_aspect_ratio=increase,crop=1080:1152[bot]",
          "[top][bot]vstack=inputs=2[out]",
        ].join(";");

    await execFileAsync("ffmpeg", [
      ...SAFE_VIDEO_INPUT_OPTIONS, "-i", videoPath,
      "-i", imagePath,
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-map", "0:a?",       // include audio if present
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-r", "30",
      "-c:a", "aac",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ], { maxBuffer: 50 * 1024 * 1024, timeout: 300_000 });

    const { readFile } = await import("node:fs/promises");
    return readFile(outputPath);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
