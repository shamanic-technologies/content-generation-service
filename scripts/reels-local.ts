/**
 * Local render of the reels pipeline, no DB and no HTTP (REELS-1124): calls the same render
 * functions the job queue calls.
 *
 *   npx tsx scripts/reels-local.ts <video file> <transcript.json> <outDir> [start] [end] [hook line]
 *
 * transcript.json = anything normalizeTranscript reads (whisper / mlx-whisper output, or our own
 * normalized shape). Writes, for the span (default: 20 s starting at 10 % of the video):
 *   cut-fit_blur.mp4, cut-crop.mp4, cut-stack.mp4, internal-hook.mp4, external-hook.mp4
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { probeSource } from "../src/lib/reels/download.js";
import { CLIP_LAYOUTS } from "../src/lib/reels/layouts.js";
import { renderCut, renderExternalHook, renderInternalHook } from "../src/lib/reels/render.js";
import { normalizeTranscript, wordsInSpan } from "../src/lib/reels/transcript.js";

async function main() {
  const [video, transcriptPath, outDir, startArg, endArg, lineArg] = process.argv.slice(2);
  if (!video || !transcriptPath || !outDir) {
    console.error("usage: npx tsx scripts/reels-local.ts <video file> <transcript.json> <outDir> [start] [end] [hook line]");
    process.exit(2);
  }
  await mkdir(outDir, { recursive: true });
  const source = await probeSource(video);
  const transcript = normalizeTranscript(JSON.parse(await readFile(transcriptPath, "utf8")));
  const start = startArg ? Number(startArg) : Math.floor(source.durationSeconds * 0.1);
  const end = endArg ? Number(endArg) : Math.min(source.durationSeconds, start + 20);
  console.log(`source ${source.width}x${source.height} ${source.durationSeconds.toFixed(1)}s audio=${source.hasAudio}; transcript ${transcript.words.length} words (${transcript.wordTimestamps}); span ${start}-${end}`);

  const cuts: Record<string, { path: string; durationSeconds: number }> = {};
  for (const layout of CLIP_LAYOUTS) {
    const t0 = Date.now();
    cuts[layout] = await renderCut({ sourcePath: video, sourceHasAudio: source.hasAudio, start, end, layout, words: transcript.words, outPath: join(outDir, `cut-${layout}.mp4`) });
    console.log(`cut ${layout}: ${cuts[layout].durationSeconds.toFixed(2)}s in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Internal hook: about 2.5 s of words from the second half of the span (a human or a model picks it in prod).
  const words = wordsInSpan(transcript, start + (end - start) / 2, end);
  const hookStart = words.length ? words[0].start : start + (end - start) / 2;
  const hookEnd = Math.min(end, (words.find((w) => w.end - hookStart >= 2.5) ?? words[words.length - 1] ?? { end: hookStart + 2.5 }).end);
  const parent = cuts.fit_blur;
  const internal = await renderInternalHook({
    sourcePath: video, sourceHasAudio: source.hasAudio, hookStart, hookEnd, layout: "fit_blur", words: transcript.words,
    parentPath: parent.path, parentSeconds: parent.durationSeconds, outPath: join(outDir, "internal-hook.mp4"),
  });
  console.log(`internal hook ${hookStart.toFixed(2)}-${hookEnd.toFixed(2)}: ${internal.durationSeconds.toFixed(2)}s`);

  const external = await renderExternalHook({
    parentPath: parent.path, parentSeconds: parent.durationSeconds, text: lineArg || "Nobody talks about why this actually works", seconds: 3,
    outPath: join(outDir, "external-hook.mp4"),
  });
  console.log(`external hook: ${external.durationSeconds.toFixed(2)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
