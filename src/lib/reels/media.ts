/**
 * Where reels files live and how they are named in a URL (REELS-1124). Env is read at CALL time.
 *
 *   ${MEDIA_DIR}/sources/<videoId>/source.<ext>   the downloaded recording (never public)
 *   ${MEDIA_DIR}/public/<token>/<file>            what GET /reels/:token/:file serves
 */
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ReelsError } from "./errors.js";

export const PUBLIC_FILES = ["clip.mp4"] as const;
export type PublicFile = (typeof PUBLIC_FILES)[number];
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{24,}$/;

/** dist/lib/reels and src/lib/reels are both three levels under the repo root. */
export const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "reels", "fonts");

export const mediaDir = () => resolve(process.env.MEDIA_DIR || "/media");
export const sourcesDir = () => join(mediaDir(), "sources");
export const publicDir = () => join(mediaDir(), "public");
export const sourceDirOf = (videoId: string) => join(sourcesDir(), videoId);
export const publicDirOf = (token: string) => join(publicDir(), token);

/** 24 random bytes, url-safe (32 characters). */
export const newToken = () => randomBytes(24).toString("base64url");

/** The absolute path of a public file, or null when token / file are not servable (traversal impossible by construction). */
export function publicFilePath(token: string, file: string): string | null {
  if (!TOKEN_PATTERN.test(token) || !(PUBLIC_FILES as readonly string[]).includes(file)) return null;
  const root = publicDir();
  const path = resolve(root, token, file);
  return path.startsWith(root + sep) ? path : null;
}

const base = (name: "PUBLIC_MEDIA_BASE_URL") => {
  const value = (process.env[name] || "").trim().replace(/\/+$/, "");
  if (!value) throw new ReelsError(`${name}_MISSING`, `${name} is not set on this service: no URL can be given for a media file`, 500);
  return value;
};

/** The URL the world fetches a clip at (Instagram's publish API reads it). */
export const publicUrl = (token: string, file: PublicFile) => `${base("PUBLIC_MEDIA_BASE_URL")}/${token}/${file}`;
/** Throws PUBLIC_MEDIA_BASE_URL_MISSING (500) before a clip is queued that could never be given a URL. */
export const assertPublicMediaBase = (): void => void base("PUBLIC_MEDIA_BASE_URL");
