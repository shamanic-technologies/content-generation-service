/**
 * Fetching one source recording onto local disk (REELS-1124): resolve the link, refuse private
 * addresses on every hop, STREAM to disk under a hard size ceiling, probe it, extract its audio.
 * Nothing here buffers media in memory, and no db: jobs.ts owns the row.
 */
import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { probeVideo, run } from "../debrief/ffmpeg.js";
import { ReelsError } from "./errors.js";
import { publicDirOf, sourceDirOf } from "./media.js";
import { MAX_SOURCE_BYTES, isForbiddenAddress, resolveSourceUrl, sourceExtension } from "./source-url.js";

const MAX_REDIRECTS = 10;
/** Free space wanted when the server declares no size. */
const UNKNOWN_SIZE_FREE_BYTES = 10 * 1024 * 1024 * 1024;
/** A download that receives nothing for this long is dead. */
const IDLE_TIMEOUT_MS = 120_000;

/** SOURCE_URL_FORBIDDEN unless every address `hostname` resolves to is public. */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch (err) {
    throw new ReelsError("SOURCE_UNREACHABLE", `${host} does not resolve: ${(err as Error).message}`, 400);
  }
  const bad = addresses.find((a) => isForbiddenAddress(a.address));
  if (!addresses.length || bad) {
    throw new ReelsError("SOURCE_URL_FORBIDDEN", `${host} resolves to a private or local address: not fetched`, 400);
  }
}

/** GET following redirects by hand: every hop is https and resolves to a public address. */
async function openSource(url: string, signal: AbortSignal): Promise<{ response: Response; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (u.protocol !== "https:") throw new ReelsError("SOURCE_URL_INVALID", `The source redirects to a non-https URL (${u.protocol}//${u.host})`, 400);
    await assertPublicHost(u.hostname);
    let response: Response;
    try {
      response = await fetch(current, { redirect: "manual", signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; media-fetch)", Accept: "*/*" } });
    } catch (err) {
      throw new ReelsError("SOURCE_UNREACHABLE", `Fetching ${u.host} failed: ${(err as Error).message}`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => {});
      current = new URL(response.headers.get("location")!, current).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ReelsError("SOURCE_UNREACHABLE", `${u.host} answered ${response.status} for the source`);
    }
    return { response, finalUrl: current };
  }
  throw new ReelsError("SOURCE_UNREACHABLE", `The source redirects more than ${MAX_REDIRECTS} times`);
}

export interface DownloadedSource {
  fileName: string;
  path: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export type DownloadStage = "downloading" | "probing";

/**
 * Downloads `sourceUrl` to `${MEDIA_DIR}/sources/<videoId>/source.<ext>` and checks it is a
 * video. On any failure the video's directory is removed and a ReelsError is thrown.
 */
export async function downloadSource(videoId: string, sourceUrl: string, onStage: (stage: DownloadStage) => void = () => {}): Promise<DownloadedSource> {
  const dir = sourceDirOf(videoId);
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await cleanup(); // a resumed job starts from nothing
    await mkdir(dir, { recursive: true });
    onStage("downloading");
    const abort = new AbortController();
    const { response, finalUrl } = await openSource(resolveSourceUrl(sourceUrl), abort.signal);

    const declared = Number(response.headers.get("content-length"));
    const known = Number.isFinite(declared) && declared > 0;
    if (known && declared > MAX_SOURCE_BYTES) {
      abort.abort();
      throw new ReelsError("SOURCE_TOO_LARGE", `The source declares ${declared} bytes; the limit is ${MAX_SOURCE_BYTES}`);
    }
    const fs = await statfs(dir);
    const free = Number(fs.bavail) * Number(fs.bsize);
    const wanted = known ? declared * 2 : UNKNOWN_SIZE_FREE_BYTES;
    if (free < wanted) {
      abort.abort();
      throw new ReelsError("DISK_FULL", `${free} bytes free under MEDIA_DIR, ${wanted} wanted for this source (${known ? "twice its declared size" : "size not declared"})`);
    }
    if (!response.body) throw new ReelsError("SOURCE_UNREACHABLE", "The source answered no body");

    const fileName = `source.${sourceExtension(finalUrl, response.headers.get("content-type"), response.headers.get("content-disposition"))}`;
    const path = join(dir, fileName);
    let total = 0;
    let idle: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(new Error(`no data for ${IDLE_TIMEOUT_MS / 1000}s`)), IDLE_TIMEOUT_MS);
    };
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        total += chunk.length;
        arm();
        if (total > MAX_SOURCE_BYTES) return done(new ReelsError("SOURCE_TOO_LARGE", `The source passed ${MAX_SOURCE_BYTES} bytes while downloading`));
        done(null, chunk);
      },
    });
    arm();
    try {
      await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(path));
    } catch (err) {
      abort.abort();
      if (err instanceof ReelsError) throw err;
      throw new ReelsError("SOURCE_UNREACHABLE", `The download died after ${total} bytes: ${(err as Error).message}`);
    } finally {
      clearTimeout(idle);
    }

    onStage("probing");
    const probed = await probeSource(path, response.headers.get("content-type"));

    return { fileName, path, sizeBytes: (await stat(path)).size, ...probed };
  } catch (err) {
    await cleanup().catch(() => {});
    if (err instanceof ReelsError) throw err;
    throw new ReelsError("SOURCE_UNREACHABLE", (err as Error).message);
  }
}

/** SOURCE_NOT_A_VIDEO unless ffprobe finds a video stream with a duration. */
export async function probeSource(path: string, contentType: string | null = null): Promise<{ durationSeconds: number; width: number; height: number; hasAudio: boolean }> {
  const hint = contentType && /html|json|text/i.test(contentType)
    ? ` The link answered ${contentType.split(";")[0]}: it is a web page (a login or a confirmation page), not the file. Use a direct download link, shared with anyone who has the link.`
    : " If the link opens a web page (a login or a preview) in a browser, it is not a direct download link.";
  let probed;
  try {
    probed = await probeVideo(path);
  } catch (err) {
    throw new ReelsError("SOURCE_NOT_A_VIDEO", `The downloaded file is not a video ffprobe can read.${hint} (${(err as Error).message.slice(0, 200)})`);
  }
  if (!probed.video || !(probed.durationSeconds > 0) || !probed.video.width || !probed.video.height) {
    throw new ReelsError("SOURCE_NOT_A_VIDEO", `The downloaded file holds no video stream.${hint}`);
  }
  return { durationSeconds: probed.durationSeconds, width: probed.video.width, height: probed.video.height, hasAudio: probed.audio !== null };
}
