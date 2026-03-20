import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

interface ComposeOptions {
  /** Raw video file bytes */
  videoBuffer: Buffer;
  /** PNG image bytes for the top panel */
  imageBuffer: Buffer;
  /** Video file extension (e.g. "mp4", "webm") */
  videoExt?: string;
}

/**
 * Compose a split-screen vertical video (1080x1920):
 *   - Top 40% (768px): static quote image
 *   - Bottom 60% (1152px): webcam video (scaled + cropped)
 * Returns the composed MP4 buffer.
 */
export async function composeSplitScreen(opts: ComposeOptions): Promise<Buffer> {
  const { videoBuffer, imageBuffer, videoExt = "mp4" } = opts;
  const tmp = await mkdtemp(join(tmpdir(), "compose-"));

  const videoPath = join(tmp, `input.${videoExt}`);
  const imagePath = join(tmp, "quote.png");
  const outputPath = join(tmp, "output.mp4");

  try {
    await Promise.all([
      writeFile(videoPath, videoBuffer),
      writeFile(imagePath, imageBuffer),
    ]);

    // FFmpeg filter:
    // 1. Scale quote image to 1080x768 (top 40%)
    // 2. Scale+crop webcam video to 1080x1152 (bottom 60%)
    // 3. Stack vertically → 1080x1920
    const filterComplex = [
      "[1:v]scale=1080:768:force_original_aspect_ratio=disable[top]",
      "[0:v]scale=1080:1152:force_original_aspect_ratio=increase,crop=1080:1152[bot]",
      "[top][bot]vstack=inputs=2[out]",
    ].join(";");

    await execFileAsync("ffmpeg", [
      "-i", videoPath,
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
