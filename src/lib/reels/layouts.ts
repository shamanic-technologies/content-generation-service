/**
 * ffmpeg filter graphs that turn any source frame into the 1080x1920 output (REELS-1124).
 * Pure leaf: strings only. Every filter and option exists in ffmpeg 5.1 (the box image).
 *
 * - `fit_blur`: the WHOLE frame fitted inside 1080x1920, over a blurred, darkened cover-scaled
 *   copy of itself. Never cuts a speaker off (the default).
 * - `crop`: cover-scaled, then a 1080-wide window at `cropX` (0 = left edge, 1 = right edge).
 * - `stack`: the left half of the frame over the right half, each cover-cropped to 1080x960
 *   (a side-by-side two-person interview).
 */
export const CLIP_LAYOUTS = ["fit_blur", "crop", "stack"] as const;
export type ClipLayout = (typeof CLIP_LAYOUTS)[number];

export const OUT_WIDTH = 1080;
export const OUT_HEIGHT = 1920;
export const OUT_FPS = 30;

/** A path as a filter option value: quoted, with the characters both escaping levels read. */
export function escapeFilterPath(path: string): string {
  // Inside '...': only ' and \ are special at the filtergraph level; the option parser then
  // reads \ and : (and ' once more), so those are escaped for it first.
  const forOption = path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  return `'${forOption.replace(/\\/g, "\\\\").replace(/'/g, "'\\''")}'`;
}

/** `subtitles=` burning one ASS file with the bundled fonts only. */
export function subtitlesFilter(assPath: string, fontsDir: string): string {
  return `subtitles=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontsDir)}`;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0.5));

/**
 * The chain from input pad `in` (e.g. `0:v`) to `[out]`: layout → 30 fps, square pixels,
 * yuv420p → the given subtitle filters (already built with `subtitlesFilter`), in order.
 */
export function layoutGraph(params: { layout: ClipLayout; cropX?: number; in: string; out: string; subtitles?: string[] }): string {
  const { layout, out } = params;
  const src = `[${params.in}]`;
  const W = OUT_WIDTH;
  const H = OUT_HEIGHT;
  const tail = ["setsar=1", `fps=${OUT_FPS}`, "format=yuv420p", ...(params.subtitles ?? [])].join(",");
  const p = `${out}_`; // private pad names, so two graphs can sit in one filter_complex
  if (layout === "crop") {
    const x = clamp01(params.cropX ?? 0.5).toFixed(4);
    return `${src}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-${W})*${x}:(ih-${H})/2,${tail}[${out}]`;
  }
  if (layout === "stack") {
    const half = `scale=${W}:${H / 2}:force_original_aspect_ratio=increase,crop=${W}:${H / 2}`;
    return [
      `${src}split=2[${p}l][${p}r]`,
      `[${p}l]crop=iw/2:ih:0:0,${half}[${p}t]`,
      `[${p}r]crop=iw/2:ih:iw/2:0,${half}[${p}b]`,
      `[${p}t][${p}b]vstack=inputs=2,${tail}[${out}]`,
    ].join(";");
  }
  // fit_blur: the background is blurred at quarter size (16x fewer pixels to blur), then scaled back.
  return [
    `${src}split=2[${p}a][${p}c]`,
    `[${p}a]scale=${W / 4}:${H / 4}:force_original_aspect_ratio=increase,crop=${W / 4}:${H / 4},boxblur=10:2,scale=${W}:${H},eq=brightness=-0.18:saturation=0.9[${p}bg]`,
    `[${p}c]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[${p}fg]`,
    `[${p}bg][${p}fg]overlay=(W-w)/2:(H-h)/2,${tail}[${out}]`,
  ].join(";");
}

/** Stereo 44.1 kHz with a 30 ms fade at each end named in `fades` (no pop at a join). */
export function audioGraph(params: { in: string; out: string; durationSeconds: number; fadeIn?: boolean; fadeOut?: boolean }): string {
  const f = 0.03;
  const parts = ["aresample=44100:async=1", "aformat=sample_fmts=fltp:channel_layouts=stereo"];
  if (params.fadeIn) parts.push(`afade=t=in:st=0:d=${f}`);
  if (params.fadeOut) parts.push(`afade=t=out:st=${Math.max(0, params.durationSeconds - f).toFixed(3)}:d=${f}`);
  return `[${params.in}]${parts.join(",")}[${params.out}]`;
}
