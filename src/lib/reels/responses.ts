/**
 * A video / clip row as the API answers it (REELS-1124). No db: rows in, JSON out.
 */
import { publicUrl } from "./media.js";
import { clipExpiresAt, sourceExpiresAt } from "./retention.js";
import type { ClipRow, VideoRow } from "./store.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toVideoResponse(row: VideoRow) {
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    errorCode: row.errorCode,
    error: row.error,
    sourceUrl: row.sourceUrl,
    sizeBytes: row.sizeBytes,
    durationSeconds: row.durationSeconds,
    width: row.width,
    height: row.height,
    transcriptStatus: row.transcriptStatus,
    transcriptLanguage: row.transcriptLanguage,
    transcriptError: row.transcriptError,
    createdAt: row.createdAt.toISOString(),
    readyAt: iso(row.readyAt),
    sourceExpiresAt: iso(sourceExpiresAt(row.readyAt)),
    sourceDeletedAt: iso(row.sourceDeletedAt),
  };
}

/** `text` = the words spoken in the clip (null without a transcript); the caller reads it. Throws PUBLIC_MEDIA_BASE_URL_MISSING for a done clip when the env is not set. */
export function toClipResponse(row: ClipRow, text: string | null = null) {
  const expired = row.status === "done" && row.fileDeletedAt !== null;
  return {
    id: row.id,
    kind: row.kind,
    status: expired ? "expired" : row.status,
    stage: row.stage,
    errorCode: row.errorCode,
    error: row.error,
    videoId: row.videoId,
    parentClipId: row.parentClipId,
    start: row.startSeconds,
    end: row.endSeconds,
    layout: row.layout,
    cropX: row.cropX,
    captions: row.captions,
    hook: row.hook ?? null,
    url: row.status === "done" && !expired ? publicUrl(row.token, "clip.mp4") : null,
    durationSeconds: row.durationSeconds,
    sizeBytes: row.sizeBytes,
    text,
    createdAt: row.createdAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    expiresAt: iso(clipExpiresAt(row.finishedAt)),
  };
}
