/**
 * What the reels retention sweep deletes (REELS-1124). Pure leaf: rows + a directory listing in,
 * a plan out; jobs.ts does the I/O.
 *
 * - A source file and its audio go SOURCE_RETENTION_DAYS after the video became ready (the
 *   transcript stays on the row: moments can still be read, new clips cannot be cut).
 * - A clip file goes CLIP_RETENTION_DAYS after it finished (the row stays: GET answers `expired`).
 * - A directory under MEDIA_DIR that no row names, older than ORPHAN_MIN_AGE_MS, is removed
 *   (a crash between writing a file and writing its row).
 */
export const SOURCE_RETENTION_DAYS = 7;
export const CLIP_RETENTION_DAYS = 30;
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function sourceExpiresAt(readyAt: Date | null): Date | null {
  return readyAt ? new Date(readyAt.getTime() + SOURCE_RETENTION_DAYS * DAY_MS) : null;
}

export function clipExpiresAt(finishedAt: Date | null): Date | null {
  return finishedAt ? new Date(finishedAt.getTime() + CLIP_RETENTION_DAYS * DAY_MS) : null;
}

export interface RetentionVideo { id: string; status: string; readyAt: Date | null; sourceDeletedAt: Date | null }
export interface RetentionClip { id: string; status: string; finishedAt: Date | null; fileDeletedAt: Date | null; token: string | null }
export interface MediaDir { name: string; modifiedAt: Date }

export interface RetentionPlan {
  /** Videos whose source directory is deleted now. */
  expireSources: Array<{ id: string }>;
  /** Clips whose public directory is deleted now. */
  expireClips: Array<{ id: string; token: string }>;
  /** Names under `${MEDIA_DIR}/sources` no video row names. */
  orphanSourceDirs: string[];
  /** Names under `${MEDIA_DIR}/public` no clip token names. */
  orphanPublicDirs: string[];
}

export function planRetention(input: {
  now: Date;
  videos: RetentionVideo[];
  clips: RetentionClip[];
  sourceDirs: MediaDir[];
  publicDirs: MediaDir[];
}): RetentionPlan {
  const now = input.now.getTime();
  const expireSources = input.videos
    .filter((v) => v.status === "ready" && !v.sourceDeletedAt && v.readyAt && sourceExpiresAt(v.readyAt)!.getTime() <= now)
    .map((v) => ({ id: v.id }));
  const expireClips = input.clips
    .filter((c) => c.status === "done" && !c.fileDeletedAt && c.token && c.finishedAt && clipExpiresAt(c.finishedAt)!.getTime() <= now)
    .map((c) => ({ id: c.id, token: c.token! }));

  const old = (d: MediaDir) => now - d.modifiedAt.getTime() > ORPHAN_MIN_AGE_MS;
  const videoIds = new Set(input.videos.map((v) => v.id));
  // A token still names its directory until the sweep deletes it: rows already expired hold none on disk.
  const tokens = new Set<string>();
  for (const c of input.clips) if (c.token && !c.fileDeletedAt) tokens.add(c.token);
  return {
    expireSources,
    expireClips,
    orphanSourceDirs: input.sourceDirs.filter((d) => !videoIds.has(d.name) && old(d)).map((d) => d.name),
    orphanPublicDirs: input.publicDirs.filter((d) => !tokens.has(d.name) && old(d)).map((d) => d.name),
  };
}
