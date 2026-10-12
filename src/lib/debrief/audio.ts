/**
 * The bulletin's soundtrack: the music cut plus synthesized UI sounds placed on
 * the scene's events (window.SFX), mixed like promo-motion's audio.py (news cut:
 * music 0.35, sfx 0.55, peak-normalized to 0.97). Port of the four sounds the
 * debrief scene uses. The music is never looped: a decode shorter than the video
 * is MUSIC_UNAVAILABLE.
 */
import { DebriefError } from "./errors.js";
import { run } from "./ffmpeg.js";

export const SAMPLE_RATE = 48000;
export const MUSIC_GAIN = 0.35;
export const SFX_GAIN = 0.55;

export interface SfxEvent { t: number; type: string; p?: number }

// Seeded so a re-render is byte-identical (audio.py: default_rng(7)).
function gaussian(seed: number): () => number {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

function env(n: number, attack: number, decay: number): Float64Array {
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) e[i] = Math.exp(-(i / SAMPLE_RATE) / decay);
  const na = Math.max(1, Math.floor(attack * SAMPLE_RATE));
  for (let i = 0; i < Math.min(na, n); i++) e[i] *= na === 1 ? 0 : i / (na - 1);
  return e;
}
function tone(f: number, dur: number, decay: number, attack = 0.001): Float64Array {
  const n = Math.floor(dur * SAMPLE_RATE), e = env(n, attack, decay);
  for (let i = 0; i < n; i++) e[i] *= Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
  return e;
}
function sweep(f0: number, f1: number, dur: number, decay: number): Float64Array {
  const n = Math.floor(dur * SAMPLE_RATE), e = env(n, 0.002, decay);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += f0 + ((f1 - f0) * i) / Math.max(1, n - 1);
    e[i] *= Math.sin((2 * Math.PI * phase) / SAMPLE_RATE);
  }
  return e;
}
function noise(rand: () => number, dur: number, decay: number): Float64Array {
  const n = Math.floor(dur * SAMPLE_RATE), e = env(n, 0.0005, decay);
  for (let i = 0; i < n; i++) e[i] *= rand();
  return e;
}
function sum(...parts: Array<[number, Float64Array]>): Float64Array {
  const n = Math.max(...parts.map(([, x]) => x.length)), o = new Float64Array(n);
  for (const [g, x] of parts) for (let i = 0; i < x.length; i++) o[i] += g * x[i];
  return o;
}

export function synthSound(type: string, p: number, rand: () => number): Float64Array {
  switch (type) {
    case "key": return sum([0.35, noise(rand, 0.025, 0.003)], [0.25, tone(3200 * p, 0.025, 0.004)]);
    case "chime": return sum([0.35, tone(1318.5 * p, 0.5, 0.18)], [0.35 * 0.7, tone(1975.5 * p, 0.5, 0.14)]);
    case "pop": return sum([0.5, sweep(500 * p, 1400 * p, 0.09, 0.025)]);
    case "send": return sum([0.45, sweep(1400 * p, 700 * p, 0.12, 0.035)]);
    default: throw new DebriefError("RENDER_FAILED", `The scene asked for an unknown sound "${type}"`);
  }
}

/** Mono sfx track of `n` samples, each sound's audible peak on its event time. */
export function sfxTrack(events: SfxEvent[], n: number): Float64Array {
  const rand = gaussian(7), fx = new Float64Array(n);
  for (const e of events) {
    const s = synthSound(e.type, e.p ?? 1, rand);
    let pk = 0;
    for (let i = 1; i < s.length; i++) if (Math.abs(s[i]) > Math.abs(s[pk])) pk = i;
    const at = Math.round(e.t * SAMPLE_RATE) - pk;
    for (let i = Math.max(0, at); i < Math.min(n, at + s.length); i++) fx[i] += s[i - at];
  }
  return fx;
}

/** Interleaved stereo f32: music x MUSIC_GAIN + sfx x SFX_GAIN, peak-normalized to 0.97. */
export function mixStereo(music: Float32Array, fx: Float64Array): Float32Array {
  const n = fx.length, out = new Float32Array(n * 2), fade = Math.floor(0.008 * SAMPLE_RATE);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const ramp = i < fade ? i / (fade - 1) : i >= n - fade ? (n - 1 - i) / (fade - 1) : 1;
    for (let c = 0; c < 2; c++) {
      const v = music[i * 2 + c] * ramp * MUSIC_GAIN + fx[i] * SFX_GAIN;
      out[i * 2 + c] = v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
  }
  const k = Math.max(1, peak / 0.97);
  if (k > 1) for (let i = 0; i < out.length; i++) out[i] /= k;
  return out;
}

/** Writes the mixed soundtrack (exactly `seconds` long) to `outPath` as AAC. */
export async function buildSoundtrack(
  songPath: string, startSeconds: number, seconds: number, events: SfxEvent[], outPath: string,
): Promise<void> {
  const raw = await run("ffmpeg", [
    "-v", "error", "-ss", String(startSeconds), "-t", String(seconds), "-i", songPath,
    "-ac", "2", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-",
  ]);
  const n = Math.round(seconds * SAMPLE_RATE);
  const decoded = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  if (decoded.length / 2 < n - SAMPLE_RATE * 0.05) {
    throw new DebriefError(
      "MUSIC_UNAVAILABLE",
      `The track decoded to ${(decoded.length / 2 / SAMPLE_RATE).toFixed(2)}s for a ${seconds.toFixed(2)}s video (never looped)`,
    );
  }
  const music = new Float32Array(n * 2);
  music.set(decoded.subarray(0, Math.min(decoded.length, n * 2)));
  const mix = mixStereo(music, sfxTrack(events, n));
  await run("ffmpeg", [
    "-v", "error", "-y", "-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", "2", "-i", "-",
    "-c:a", "aac", "-b:a", "256k", outPath,
  ], Buffer.from(mix.buffer, mix.byteOffset, mix.byteLength));
}
