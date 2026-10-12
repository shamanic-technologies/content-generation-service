/**
 * One industry debrief render, end to end on local disk: capture the posts,
 * write the scene, read its timeline, pick the music, render, mix, mux, check.
 * Storage, the job row and runs-service live in jobs.ts; this file only turns a
 * request into a verified MP4 or a DebriefError.
 */
import { chromium, type Browser } from "playwright";
import { chmod, copyFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { DebriefVideoRequest } from "../../schemas.js";
import { DebriefError } from "./errors.js";
import { buildSceneData, storyKey } from "./scene-data.js";
import { capturePosts } from "./capture.js";
import { readTimeline, renderSilent } from "./render.js";
import { MUSIC_START_SECONDS, pickMusic } from "./music.js";
import { buildSoundtrack } from "./audio.js";
import { RENDER_NICE, isFaststart, probeVideo, run } from "./ffmpeg.js";
import { assertDeliverable } from "./output-check.js";

/** dist/lib/debrief and src/lib/debrief are both three levels under the repo root. */
export const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "industry-debrief");

export interface RenderedDebrief {
  path: string;
  durationSeconds: number;
  musicTrackId: number;
  /** Removes the work directory (call once the file is uploaded). */
  cleanup: () => Promise<void>;
}

export type RenderStage = "capturing" | "rendering" | "mixing" | "checking";

/** Chromium and every renderer it forks run at RENDER_NICE: wrap the executable in `nice`. */
async function launchLowPriority(dir: string): Promise<Browser> {
  const wrapper = join(dir, "chromium-nice.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec nice -n ${RENDER_NICE} "${chromium.executablePath()}" "$@"\n`);
  await chmod(wrapper, 0o755);
  return chromium.launch({ executablePath: wrapper });
}

export async function renderDebriefVideo(
  req: DebriefVideoRequest,
  previousTrackId: number | null,
  onStage: (stage: RenderStage) => void = () => {},
): Promise<RenderedDebrief> {
  const dir = await mkdtemp(join(tmpdir(), "debrief-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  let browser: Browser | undefined;
  try {
    browser = await launchLowPriority(dir);

    onStage("capturing");
    const stories = req.stories.map((story, i) => ({ key: storyKey(i), story }));
    const posts = await capturePosts(browser, stories, dir, join(ASSETS_DIR, "capture-page.js"));
    const html = join(dir, "index.html");
    await copyFile(join(ASSETS_DIR, "scene.html"), html);
    await copyFile(join(ASSETS_DIR, "engine.js"), join(dir, "engine.js"));
    await writeFile(join(dir, "posts.js"), `window.POSTS = ${JSON.stringify(posts)};\n`);
    await writeFile(join(dir, "data.js"), `window.DEBRIEF_DATA = ${JSON.stringify(buildSceneData(req))};\n`);

    onStage("rendering");
    const { durationSeconds, sfx } = await readTimeline(browser, html);
    const music = await pickMusic(durationSeconds, previousTrackId);
    const silent = join(dir, "silent.mp4");
    await renderSilent(browser, html, durationSeconds, dir, silent);
    await browser.close();
    browser = undefined;

    onStage("mixing");
    const mix = join(dir, "mix.m4a");
    await buildSoundtrack(music.path, MUSIC_START_SECONDS, durationSeconds, sfx, mix);
    const out = join(dir, "debrief.mp4");
    try {
      await run("ffmpeg", [
        "-v", "error", "-y", "-i", silent, "-i", mix, "-map", "0:v", "-map", "1:a",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out,
      ]);
    } catch (err) {
      throw new DebriefError("RENDER_FAILED", `Muxing audio: ${(err as Error).message}`);
    }

    onStage("checking");
    const fh = await open(out, "r");
    const head = Buffer.alloc(65536);
    await fh.read(head, 0, head.length, 0);
    await fh.close();
    assertDeliverable(await probeVideo(out), durationSeconds, isFaststart(head));

    return { path: out, durationSeconds, musicTrackId: music.trackId, cleanup };
  } catch (err) {
    await browser?.close().catch(() => {});
    await cleanup();
    if (err instanceof DebriefError) throw err;
    throw new DebriefError("RENDER_FAILED", (err as Error).message);
  }
}
