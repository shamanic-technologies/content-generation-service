/**
 * Renders an industry debrief locally, no database, no upload:
 *   npx tsx scripts/render-debrief.ts <request.json> <out.mp4> [previousTrackId]
 * Same code path as POST /industry-debrief-videos (src/lib/debrief/pipeline.ts).
 */
import { readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { DebriefVideoRequestSchema } from "../src/schemas.js";
import { renderDebriefVideo } from "../src/lib/debrief/pipeline.js";

const [input, out, prev] = process.argv.slice(2);
if (!input || !out) {
  console.error("usage: tsx scripts/render-debrief.ts <request.json> <out.mp4> [previousTrackId]");
  process.exit(2);
}
const req = DebriefVideoRequestSchema.parse(JSON.parse(readFileSync(input, "utf8")));
const t0 = Date.now();
const r = await renderDebriefVideo(req, prev ? Number(prev) : null, (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`));
await copyFile(r.path, out);
await r.cleanup();
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${out} duration=${r.durationSeconds.toFixed(3)}s track=${r.musicTrackId}`);
