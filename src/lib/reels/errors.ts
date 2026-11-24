/**
 * Every way a reels step can fail, by name (REELS-1124). A route answers `{ error, code }` with
 * the error's `httpStatus`; a background job stores `code` + message on its row and serves them
 * on the GET. Standalone leaf: `schemas.ts` reads REELS_ERROR_CODES.
 */
export const REELS_ERROR_CODES = [
  "SOURCE_URL_INVALID", // not an https URL
  "SOURCE_URL_FORBIDDEN", // the host resolves to a private / loopback / link-local address
  "SOURCE_TOO_LARGE", // declared or downloaded size over MAX_SOURCE_BYTES
  "SOURCE_UNREACHABLE", // the download answered an error or died mid-stream
  "SOURCE_NOT_A_VIDEO", // ffprobe found no video stream (an HTML login page lands here)
  "DISK_FULL", // not enough free space under MEDIA_DIR for this source
  "SOURCE_EXPIRED", // the source file passed its retention and was deleted
  "VIDEO_NOT_READY", // the download has not finished
  "TRANSCRIPT_NOT_READY", // no finished transcript for this video
  "TRANSCRIPTION_FAILED", // chat-service refused or failed the transcription
  "CLIP_RANGE_INVALID", // span not 3..180 s or outside the video
  "CLIP_NOT_READY", // the parent clip is not rendered yet (or failed)
  "CLIP_EXPIRED", // the parent clip's file passed its retention and was deleted
  "MODEL_WITH_COMPLETION", // more than one of model / completion / explicit choice
  "MODEL_REQUIRED", // none of them
  "NO_MOMENTS", // the model answered no usable moment
  "HOOK_UNREADABLE", // the model's hook names words / a library hook that do not exist
  "HOOK_LIBRARY_EMPTY", // no active hook in the library
  "RENDER_FAILED", // ffmpeg failed
  "OUTPUT_INVALID", // the finished MP4 failed its ffprobe checks
  "INTERRUPTED", // the process restarted mid-job and the job was too old to resume
  "PUBLIC_MEDIA_BASE_URL_MISSING", // env PUBLIC_MEDIA_BASE_URL is not set
] as const;

export type ReelsErrorCode = (typeof REELS_ERROR_CODES)[number];

export class ReelsError extends Error {
  constructor(
    public readonly code: ReelsErrorCode,
    message: string,
    public readonly httpStatus: number = 500,
  ) {
    super(message);
    this.name = "ReelsError";
  }
}
