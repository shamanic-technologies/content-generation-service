/**
 * Music for the bulletin. Rules from the industry-debrief-video skill:
 * the track is LONGER than the video (duration - start >= video + 3 s, never
 * looped), consecutive days use different tracks, and Mixkit 130 (promo-motion's
 * track) is never used here.
 */
import { mkdir, stat, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DebriefError } from "./errors.js";
import { probeDurationSeconds } from "./ffmpeg.js";

/** Rotation order with the skill's listed lengths (seconds). Verified by ffprobe before use. */
export const MUSIC_TRACKS: ReadonlyArray<{ id: number; seconds: number }> = [
  { id: 184, seconds: 230 },
  { id: 127, seconds: 134 },
  { id: 669, seconds: 121 },
  { id: 1170, seconds: 116 },
  { id: 738, seconds: 115 },
  { id: 54, seconds: 103 },
  { id: 1024, seconds: 100 },
  { id: 720, seconds: 96 },
  { id: 702, seconds: 68 },
];
export const PROMO_TRACK_ID = 130;
export const MUSIC_START_SECONDS = 0;
export const MUSIC_TAIL_SECONDS = 3;

/**
 * Candidate tracks, best first: rotation order starting AFTER the previous render's
 * track, the previous track itself excluded, only those whose listed length fits.
 */
export function musicCandidates(videoSeconds: number, previousTrackId: number | null): number[] {
  const need = videoSeconds + MUSIC_START_SECONDS + MUSIC_TAIL_SECONDS;
  const start = MUSIC_TRACKS.findIndex((t) => t.id === previousTrackId) + 1; // -1 + 1 = 0 when none
  const ordered = [...MUSIC_TRACKS.slice(start), ...MUSIC_TRACKS.slice(0, start)];
  return ordered
    .filter((t) => t.id !== previousTrackId && t.id !== PROMO_TRACK_ID && t.seconds >= need)
    .map((t) => t.id);
}

const CACHE_DIR = join(tmpdir(), "debrief-music");

async function fetchTrack(id: number): Promise<string> {
  const path = join(CACHE_DIR, `${id}.mp3`);
  const cached = await stat(path).catch(() => null);
  if (cached && cached.size > 0) return path;
  await mkdir(CACHE_DIR, { recursive: true });
  const url = `https://assets.mixkit.co/music/${id}/${id}.mp3`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const tmp = `${path}.part`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await rename(tmp, path);
  return path;
}

/** Picks and fetches a track that outlasts the video, or throws MUSIC_UNAVAILABLE. */
export async function pickMusic(
  videoSeconds: number,
  previousTrackId: number | null,
): Promise<{ trackId: number; path: string; trackSeconds: number }> {
  const tried: string[] = [];
  for (const id of musicCandidates(videoSeconds, previousTrackId)) {
    try {
      const path = await fetchTrack(id);
      const trackSeconds = await probeDurationSeconds(path);
      if (trackSeconds - MUSIC_START_SECONDS >= videoSeconds + MUSIC_TAIL_SECONDS) {
        return { trackId: id, path, trackSeconds };
      }
      tried.push(`${id}: ${trackSeconds.toFixed(1)}s is too short`);
    } catch (err) {
      tried.push(`${id}: ${(err as Error).message}`);
    }
  }
  throw new DebriefError(
    "MUSIC_UNAVAILABLE",
    `No track outlasts a ${videoSeconds.toFixed(1)}s video by ${MUSIC_TAIL_SECONDS}s (previous track ${previousTrackId ?? "none"}). Tried: ${tried.join("; ") || "none fit by listed length"}`,
  );
}
