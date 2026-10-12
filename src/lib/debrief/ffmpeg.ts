/**
 * ffmpeg / ffprobe as child processes. Every render child runs at a lower CPU
 * priority (RENDER_NICE): the box serves the whole fleet, a 10-minute render
 * must not starve request handlers.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";

export const RENDER_NICE = 10;

export function lowerPriority(child: ChildProcess | { pid?: number }): void {
  if (child.pid) setPriority(child.pid, RENDER_NICE);
}

/** Runs a command to completion; resolves stdout, rejects with stderr on a non-zero exit. */
export function run(cmd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    lowerPriority(child);
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${err.trim()}`));
    });
    child.stdin.on("error", () => {}); // EPIPE when the child exits early: the close handler reports it
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function probeDurationSeconds(path: string): Promise<number> {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  const s = parseFloat(out.toString().trim());
  if (!Number.isFinite(s)) throw new Error(`ffprobe gave no duration for ${path}`);
  return s;
}

export interface ProbedVideo {
  durationSeconds: number;
  video: { codec: string; pixFmt: string; width: number; height: number } | null;
  audio: { codec: string } | null;
}

export async function probeVideo(path: string): Promise<ProbedVideo> {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height:format=duration",
    "-of", "json", path,
  ]);
  const j = JSON.parse(out.toString()) as {
    streams: Array<{ codec_type: string; codec_name: string; pix_fmt?: string; width?: number; height?: number }>;
    format: { duration: string };
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return {
    durationSeconds: parseFloat(j.format.duration),
    video: v ? { codec: v.codec_name, pixFmt: v.pix_fmt ?? "", width: v.width ?? 0, height: v.height ?? 0 } : null,
    audio: a ? { codec: a.codec_name } : null,
  };
}

/** Faststart = the moov atom precedes mdat, so a browser plays before the download ends. */
export function isFaststart(head: Buffer): boolean {
  const moov = head.indexOf("moov");
  const mdat = head.indexOf("mdat");
  return moov >= 0 && (mdat < 0 || moov < mdat);
}
