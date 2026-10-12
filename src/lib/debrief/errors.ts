/**
 * Every way an industry debrief render can fail, by name. A failed render is
 * stored with one of these codes and served on `GET /industry-debrief-videos/{id}`;
 * no code path uploads a partial video.
 */
export const DEBRIEF_ERROR_CODES = [
  "EMBED_UNREACHABLE", // the public LinkedIn/X embed did not load or rendered no post
  "SPOTLIGHT_NOT_FOUND", // a sentence to spotlight is not verbatim in the post
  "CROP_PHRASE_NOT_FOUND", // the cropFrom phrase is not verbatim in the post
  "FONT_NOT_LOADED", // the scene fonts did not load, the frames would use a fallback face
  "MUSIC_UNAVAILABLE", // no rotation track is longer than the video (never looped)
  "RENDER_FAILED", // the scene threw, or a frame/encode step failed
  "OUTPUT_INVALID", // the finished MP4 failed its ffprobe checks
  "UPLOAD_FAILED", // cloudflare-service refused the upload
  "RENDER_INTERRUPTED", // the process restarted mid-render and the job was too old to resume
] as const;

export type DebriefErrorCode = (typeof DEBRIEF_ERROR_CODES)[number];

export class DebriefError extends Error {
  constructor(
    public readonly code: DebriefErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DebriefError";
  }
}
