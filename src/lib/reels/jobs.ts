/**
 * The background work behind the reels routes (REELS-1124), all in this process, all persisted
 * on its row so a poll survives a restart:
 *  - downloads, ONE at a time (a 2 GB stream + an ffmpeg audio pass);
 *  - renders, ONE at a time (the box serves the fleet; ffmpeg children run at nice 10);
 *  - the transcription poller (chat-service does the work; `transcript_ref` is stored);
 *  - the retention sweep (retention.ts plans, this file deletes).
 * No run is opened and nothing is declared: every row carries the CALLER's run.
 *
 * Restart: a job younger than RESUME_MAX_AGE_MS starts again from scratch, an older one is
 * failed INTERRUPTED. Boot hooks are called after listen() and never awaited.
 */
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TimedWord } from "./captions-ass.js";
import { downloadSource } from "./download.js";
import { ReelsError } from "./errors.js";
import type { ClipLayout } from "./layouts.js";
import { publicDir, publicDirOf, sourceDirOf, sourcesDir } from "./media.js";
import { resolveSourceUrl } from "./source-url.js";
import { renderCut, renderExternalHook, renderInternalHook, type RenderedClip } from "./render.js";
import { planRetention, type MediaDir } from "./retention.js";
import {
  claimTranscript, clipsInStatus, getClip, getVideo, readTranscript, retentionRows, updateClip, updateVideo,
  videosInStatus, videosInTranscriptStatus, type ClipRow, type VideoRow,
} from "./store.js";
import { normalizeTranscript } from "./transcript.js";
import { readTranscription, startTranscription, TranscriptionRefusedError, type TranscriptionIdentity } from "./transcription-client.js";

export const RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** A transcription chat-service has not finished after this long is failed (a 2 h recording takes minutes). */
export const TRANSCRIPTION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const TRANSCRIPT_POLL_MS = 20_000;
const TRANSCRIPT_FIRST_TICK_MS = 30_000;
const RETENTION_SWEEP_MS = 60 * 60 * 1000;
const RETENTION_FIRST_TICK_MS = 60_000;

const errorOf = (err: unknown, fallback: ReelsError["code"]) => ({
  errorCode: err instanceof ReelsError ? err.code : fallback,
  error: (err as Error).message,
});

/** A queue that runs its jobs one after the other. */
function serialQueue(name: string, work: (id: string) => Promise<void>) {
  const queue: string[] = [];
  let draining = false;
  return (id: string) => {
    if (!queue.includes(id)) queue.push(id);
    if (draining) return;
    draining = true;
    void (async () => {
      try {
        while (queue.length) {
          const next = queue.shift()!;
          await work(next).catch((err) => console.error(`[reels] ${name} ${next} crashed outside its error handling:`, err));
        }
      } finally {
        draining = false;
      }
    })();
  };
}

// --------------------------------------------------------------------------- downloads

export async function processVideo(id: string): Promise<void> {
  const row = await getVideo(id);
  if (!row || row.status === "ready" || row.status === "failed") return;
  const t0 = Date.now();
  await updateVideo(id, { status: "downloading", stage: null });
  const setStage = (stage: string) => {
    console.log(`[reels] video ${id} ${stage} (+${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    updateVideo(id, { stage }).catch((err) => console.error(`[reels] video ${id} stage write failed:`, err));
  };
  try {
    const source = await downloadSource(id, row.sourceUrl, setStage);
    await updateVideo(id, {
      status: "ready", stage: null, sourceFile: source.fileName, sizeBytes: source.sizeBytes, durationSeconds: source.durationSeconds,
      width: source.width, height: source.height, hasAudio: source.hasAudio, readyAt: new Date(),
    });
    console.log(`[reels] video ${id} ready in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${source.sizeBytes} bytes, ${source.durationSeconds.toFixed(1)}s, ${source.width}x${source.height}`);
  } catch (err) {
    const failure = errorOf(err, "SOURCE_UNREACHABLE");
    console.error(`[reels] video ${id} FAILED ${failure.errorCode}: ${failure.error}`);
    await updateVideo(id, { status: "failed", stage: null, ...failure });
  }
}

export const enqueueVideo = serialQueue("video", processVideo);

// --------------------------------------------------------------------------- renders

export interface InternalHookData { type: "internal"; start: number; end: number; quote: string; why: string; proposalId: string | null }
export interface ExternalHookData { type: "external"; hookId: string | null; template: string | null; text: string; source: string | null; seconds: number; why: string; proposalId: string | null }

async function parentFile(row: ClipRow): Promise<{ path: string; seconds: number }> {
  const parent = row.parentClipId ? await getClip(row.parentClipId) : undefined;
  if (!parent || parent.status !== "done" || !parent.durationSeconds) throw new ReelsError("CLIP_NOT_READY", "The clip this hook is added to is not rendered");
  if (parent.fileDeletedAt) throw new ReelsError("CLIP_EXPIRED", "The clip this hook is added to passed its retention: its file is deleted");
  return { path: join(publicDirOf(parent.token), "clip.mp4"), seconds: parent.durationSeconds };
}

async function sourceOf(row: ClipRow): Promise<{ path: string; hasAudio: boolean; words: TimedWord[] | null }> {
  const video = await getVideo(row.videoId);
  if (!video || video.status !== "ready" || !video.sourceFile) throw new ReelsError("VIDEO_NOT_READY", "The source video is not downloaded");
  if (video.sourceDeletedAt) throw new ReelsError("SOURCE_EXPIRED", "The source video passed its retention: its file is deleted");
  let words: TimedWord[] | null = null;
  if (row.captions) {
    const transcript = await readTranscript(row.videoId);
    if (!transcript) throw new ReelsError("TRANSCRIPT_NOT_READY", "Captions need the video's transcript, and it has none");
    words = transcript.words;
  }
  return { path: join(sourceDirOf(video.id), video.sourceFile), hasAudio: video.hasAudio !== false, words };
}

export async function processClip(id: string): Promise<void> {
  const row = await getClip(id);
  if (!row || row.status === "done" || row.status === "failed") return;
  const t0 = Date.now();
  await updateClip(id, { status: "rendering", stage: null });
  const setStage = (stage: string) => {
    console.log(`[reels] clip ${id} ${stage} (+${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    updateClip(id, { stage }).catch((err) => console.error(`[reels] clip ${id} stage write failed:`, err));
  };
  const dir = publicDirOf(row.token);
  // Not in the public allowlist: the file is unreachable until it passed its checks and is renamed.
  const partial = join(dir, "clip.partial.mp4");
  try {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const hook = row.hook as InternalHookData | ExternalHookData | null;
    const layout = row.layout as ClipLayout;
    let rendered: RenderedClip;
    if (row.kind === "cut") {
      setStage("rendering");
      const source = await sourceOf(row);
      rendered = await renderCut({ sourcePath: source.path, sourceHasAudio: source.hasAudio, start: row.startSeconds, end: row.endSeconds, layout, cropX: row.cropX, words: source.words, outPath: partial });
    } else if (hook?.type === "internal") {
      setStage("rendering_hook");
      const [source, parent] = [await sourceOf(row), await parentFile(row)];
      rendered = await renderInternalHook({
        sourcePath: source.path, sourceHasAudio: source.hasAudio, hookStart: hook.start, hookEnd: hook.end, layout, cropX: row.cropX,
        words: source.words, parentPath: parent.path, parentSeconds: parent.seconds, outPath: partial,
      });
    } else if (hook?.type === "external") {
      setStage("rendering_hook");
      const parent = await parentFile(row);
      rendered = await renderExternalHook({ parentPath: parent.path, parentSeconds: parent.seconds, text: hook.text, seconds: hook.seconds, outPath: partial });
    } else {
      throw new ReelsError("RENDER_FAILED", `Clip of kind ${row.kind} carries no hook to render`);
    }
    await rename(partial, join(dir, "clip.mp4"));
    const sizeBytes = (await stat(join(dir, "clip.mp4"))).size;
    await updateClip(id, { status: "done", stage: null, fileName: "clip.mp4", sizeBytes, durationSeconds: rendered.durationSeconds, finishedAt: new Date() });
    console.log(`[reels] clip ${id} done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${rendered.durationSeconds.toFixed(2)}s, ${sizeBytes} bytes`);
  } catch (err) {
    const failure = errorOf(err, "RENDER_FAILED");
    console.error(`[reels] clip ${id} FAILED ${failure.errorCode}: ${failure.error}`);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await updateClip(id, { status: "failed", stage: null, ...failure, finishedAt: new Date() });
  }
}

export const enqueueClip = serialQueue("clip", processClip);

/** Boot: re-queue the jobs a restart interrupted, fail the stale ones. */
export async function resumeReelsJobs(now = Date.now()): Promise<void> {
  const stale = (createdAt: Date) => now - createdAt.getTime() > RESUME_MAX_AGE_MS;
  const message = `The process restarted during this job and it is older than ${RESUME_MAX_AGE_MS / 3600000}h: not resumed`;
  for (const row of await videosInStatus(["queued", "downloading"])) {
    if (stale(row.createdAt)) {
      console.error(`[reels] video ${row.id} FAILED INTERRUPTED`);
      await updateVideo(row.id, { status: "failed", stage: null, errorCode: "INTERRUPTED", error: message });
    } else {
      console.warn(`[reels] video ${row.id} was ${row.status} at boot: downloading it again`);
      await updateVideo(row.id, { status: "queued", stage: null });
      enqueueVideo(row.id);
    }
  }
  for (const row of await clipsInStatus(["queued", "rendering"])) {
    if (stale(row.createdAt)) {
      console.error(`[reels] clip ${row.id} FAILED INTERRUPTED`);
      await updateClip(row.id, { status: "failed", stage: null, errorCode: "INTERRUPTED", error: message, finishedAt: new Date() });
    } else {
      console.warn(`[reels] clip ${row.id} was ${row.status} at boot: rendering it again`);
      await updateClip(row.id, { status: "queued", stage: null });
      enqueueClip(row.id);
    }
  }
}

// --------------------------------------------------------------------------- transcription

type StoredTranscriptIdentity = TranscriptionIdentity & { language?: string | null; askedAt?: string };

/**
 * Asks for a video's transcript. Idempotent: queued / transcribing / done answer the current
 * state and ask nothing; none / failed (re-)ask. Returns the transcript status after the call.
 */
export async function requestTranscript(video: VideoRow, ask: { language: string | null; transcriptionId?: string | null }, identity: TranscriptionIdentity): Promise<string> {
  const language = ask.language;
  if (video.status !== "ready") throw new ReelsError("VIDEO_NOT_READY", `The video is ${video.status}: its transcript can be asked once it is ready`, 409);
  if (["queued", "transcribing", "done"].includes(video.transcriptStatus)) return video.transcriptStatus;
  if (video.hasAudio === false) throw new ReelsError("TRANSCRIPTION_FAILED", "The source video has no audio track: nothing to transcribe", 422);
  const stored: StoredTranscriptIdentity = { ...identity, language, askedAt: new Date().toISOString() };
  const claimed = await claimTranscript(video.id, ["none", "failed"], {
    // A transcription the caller already started is only READ: never a second one for the same recording.
    transcriptStatus: ask.transcriptionId ? "transcribing" : "queued", transcriptIdentity: stored, transcriptRef: ask.transcriptionId ?? null, transcriptError: null, transcriptLanguage: null,
  });
  if (!claimed) return (await getVideo(video.id))?.transcriptStatus ?? "queued";
  void advanceTranscripts();
  return ask.transcriptionId ? "transcribing" : "queued";
}

let advancing = false;

/** One pass over every transcript in flight: start the queued ones, read the transcribing ones. Single flight. */
export async function advanceTranscripts(now = Date.now()): Promise<void> {
  if (advancing) return;
  advancing = true;
  try {
    for (const video of await videosInTranscriptStatus(["queued", "transcribing"])) {
      const identity = (video.transcriptIdentity ?? { orgId: video.orgId, userId: video.userId, runId: video.runId }) as StoredTranscriptIdentity;
      const fail = async (error: string) => {
        console.error(`[reels] video ${video.id} transcript FAILED: ${error}`);
        await updateVideo(video.id, { transcriptStatus: "failed", transcriptError: error });
      };
      try {
        if (identity.askedAt && now - Date.parse(identity.askedAt) > TRANSCRIPTION_MAX_AGE_MS) {
          await fail(`not finished ${TRANSCRIPTION_MAX_AGE_MS / 3600000}h after it was asked`);
        } else if (video.transcriptStatus === "queued" || !video.transcriptRef) {
          // chat-service fetches the recording itself, from the same public link we downloaded. The key carries
          // the ask's instant: a re-ask after `failed` is a new job there, a retried tick of this ask is the same one.
          const { ref } = await startTranscription(
            { url: resolveSourceUrl(video.sourceUrl), language: identity.language ?? null, idempotencyKey: `content-generation:video:${video.id}:${identity.askedAt ?? ""}` },
            identity,
          );
          await updateVideo(video.id, { transcriptStatus: "transcribing", transcriptRef: ref });
          console.log(`[reels] video ${video.id} transcription started: ${ref}`);
        } else {
          const read = await readTranscription(video.transcriptRef, identity);
          if (read.status === "failed") await fail(read.error ?? "the transcription failed");
          else if (read.status === "done") {
            const transcript = normalizeTranscript(read.raw);
            await updateVideo(video.id, { transcriptStatus: "done", transcript, transcriptLanguage: transcript.language ?? identity.language ?? null, transcriptError: null });
            console.log(`[reels] video ${video.id} transcript done: ${transcript.segments.length} segments, ${transcript.words.length} words (${transcript.wordTimestamps})`);
          }
        }
      } catch (err) {
        // A refusal, a missing env or an unreadable answer cannot succeed on a retry; anything else (chat-service down) is retried next tick.
        if (err instanceof TranscriptionRefusedError || err instanceof ReelsError || (err as Error).name === "TranscriptUnreadableError") await fail((err as Error).message);
        else console.error(`[reels] video ${video.id} transcript step failed, retried next tick: ${(err as Error).message}`);
      }
    }
  } finally {
    advancing = false;
  }
}

/** Boot: the poller. First tick ~30 s after boot, then every 20 s (one indexed read when nothing is in flight). */
export function startTranscriptPoller(): void {
  const tick = () => advanceTranscripts().catch((err) => console.error("[reels] transcript poller tick failed:", err));
  setTimeout(() => {
    void tick();
    setInterval(tick, TRANSCRIPT_POLL_MS).unref();
  }, TRANSCRIPT_FIRST_TICK_MS).unref();
}

// --------------------------------------------------------------------------- retention

async function listDirs(root: string): Promise<MediaDir[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const out: MediaDir[] = [];
  for (const name of names) {
    const s = await stat(join(root, name)).catch(() => null);
    if (s?.isDirectory()) out.push({ name, modifiedAt: s.mtime });
  }
  return out;
}

let sweeping = false;

export async function sweepRetention(now = new Date()): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const { videos, clips } = await retentionRows();
    const plan = planRetention({ now, videos, clips, sourceDirs: await listDirs(sourcesDir()), publicDirs: await listDirs(publicDir()) });
    for (const v of plan.expireSources) {
      await rm(sourceDirOf(v.id), { recursive: true, force: true });
      await updateVideo(v.id, { sourceDeletedAt: now });
    }
    for (const c of plan.expireClips) {
      await rm(publicDirOf(c.token), { recursive: true, force: true });
      await updateClip(c.id, { fileDeletedAt: now });
    }
    for (const name of plan.orphanSourceDirs) await rm(join(sourcesDir(), name), { recursive: true, force: true });
    for (const name of plan.orphanPublicDirs) await rm(join(publicDir(), name), { recursive: true, force: true });
    const n = plan.expireSources.length + plan.expireClips.length + plan.orphanSourceDirs.length + plan.orphanPublicDirs.length;
    if (n) console.log(`[reels] retention: ${plan.expireSources.length} source(s), ${plan.expireClips.length} clip(s), ${plan.orphanSourceDirs.length + plan.orphanPublicDirs.length} orphan dir(s) deleted`);
  } finally {
    sweeping = false;
  }
}

/** Boot: first sweep ~60 s after boot, then hourly. */
export function startRetentionSweep(): void {
  const tick = () => sweepRetention().catch((err) => console.error("[reels] retention sweep failed:", err));
  setTimeout(() => {
    void tick();
    setInterval(tick, RETENTION_SWEEP_MS).unref();
  }, RETENTION_FIRST_TICK_MS).unref();
}
