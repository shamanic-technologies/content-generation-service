/**
 * Renders the seek(t)-driven scene to a silent H.264 file: every sub-frame is a
 * Playwright screenshot of `seek(t)`, piped straight into ffmpeg (no frame files
 * on disk), with promo-motion's sub-frame motion blur (tmix over SUB frames, then
 * keep one per group). The frame range is split across WORKERS pages; each split
 * point is a multiple of SUB so every blur group stays inside one segment and the
 * concatenation equals a single-pass render.
 */
import type { Browser, Page } from "playwright";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DebriefError } from "./errors.js";
import { lowerPriority, run } from "./ffmpeg.js";
import { VIDEO_HEIGHT, VIDEO_WIDTH } from "./output-check.js";
import type { SfxEvent } from "./audio.js";

export const FPS = 30;
/** Sub-frames per output frame (motion blur). The Mac run uses 8; the shared box uses 2. */
export const SUB = 2;
export const WORKERS = 2;

export interface SceneTimeline { durationSeconds: number; sfx: SfxEvent[] }

async function openScene(browser: Browser, html: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`file://${html}`);
  const fontsOk = await page.evaluate("window.ready");
  if (errors.length) throw new DebriefError("RENDER_FAILED", `The scene threw: ${errors.join("; ")}`);
  if (!fontsOk) throw new DebriefError("FONT_NOT_LOADED", "Newsreader/Inter did not load in the scene (fonts.googleapis.com unreachable?)");
  return page;
}

export async function readTimeline(browser: Browser, html: string): Promise<SceneTimeline> {
  const page = await openScene(browser, html);
  try {
    const durationSeconds = (await page.evaluate("window.DURATION")) as number;
    const sfx = (await page.evaluate("window.SFX")) as SfxEvent[];
    if (!(durationSeconds > 0)) throw new DebriefError("RENDER_FAILED", `The scene reported duration ${durationSeconds}`);
    return { durationSeconds, sfx };
  } finally {
    await page.close();
  }
}

/** [from, to) sub-frame ranges, split points on multiples of `sub`. Pure: unit-tested. */
export function splitRanges(totalSubframes: number, sub: number, workers: number): Array<[number, number]> {
  const groups = totalSubframes / sub;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < workers; i++) {
    const a = Math.floor((groups * i) / workers) * sub, b = Math.floor((groups * (i + 1)) / workers) * sub;
    if (b > a) out.push([a, b]);
  }
  return out;
}

async function renderSegment(browser: Browser, html: string, from: number, to: number, out: string): Promise<void> {
  const page = await openScene(browser, html);
  const vf = `tmix=frames=${SUB},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/${FPS}/TB,scale=in_range=full:out_range=tv,format=yuv420p`;
  const ff = spawn("ffmpeg", [
    "-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS * SUB), "-c:v", "mjpeg", "-i", "-",
    "-vf", vf, "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "18", out,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  lowerPriority(ff);
  let stderr = "";
  ff.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
  const done = new Promise<void>((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
  });
  ff.stdin.on("error", () => {}); // reported by `done`
  try {
    for (let s = from; s < to; s++) {
      await page.evaluate(`seek(${s / (FPS * SUB)})`);
      const jpg = await page.screenshot({ type: "jpeg", quality: 94 });
      if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
    }
    ff.stdin.end();
    await done;
  } catch (err) {
    ff.kill("SIGKILL");
    if (err instanceof DebriefError) throw err;
    throw new DebriefError("RENDER_FAILED", `Frames ${from}-${to}: ${(err as Error).message}`);
  } finally {
    await page.close();
  }
}

/** Renders `html` to `out` (silent), one segment per worker, then concatenates. */
export async function renderSilent(browser: Browser, html: string, durationSeconds: number, dir: string, out: string): Promise<void> {
  const total = Math.round(durationSeconds * FPS) * SUB;
  const ranges = splitRanges(total, SUB, WORKERS);
  const segments = ranges.map((_, i) => join(dir, `seg${i}.mp4`));
  await Promise.all(ranges.map(([a, b], i) => renderSegment(browser, html, a, b, segments[i])));
  const list = join(dir, "segments.txt");
  await writeFile(list, segments.map((s) => `file '${s}'`).join("\n"));
  try {
    await run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
  } catch (err) {
    throw new DebriefError("RENDER_FAILED", `Concatenating segments: ${(err as Error).message}`);
  }
}
