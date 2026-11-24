import { describe, it, expect } from "vitest";
import { ReelsError } from "../../src/lib/reels/errors.js";
import { isForbiddenAddress, resolveSourceUrl, sourceExtension } from "../../src/lib/reels/source-url.js";
import { clock, interpolateWords, normalizeTranscript, segmentLines, spanOfSegments, textOfSpan, wordsInSpan } from "../../src/lib/reels/transcript.js";
import { audioGraph, escapeFilterPath, layoutGraph, subtitlesFilter } from "../../src/lib/reels/layouts.js";
import { assertClipDeliverable } from "../../src/lib/reels/output-check.js";
import { clipExpiresAt, planRetention, sourceExpiresAt } from "../../src/lib/reels/retention.js";
import { relativeWords } from "../../src/lib/reels/render.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ReelsError ? e.code : `not a ReelsError: ${e}`;
  }
  return "did not throw";
};

describe("reels source-url", () => {
  it("accepts https only", () => {
    expect(resolveSourceUrl("https://cdn.example.com/a/talk.mp4")).toBe("https://cdn.example.com/a/talk.mp4");
    expect(code(() => resolveSourceUrl("http://cdn.example.com/talk.mp4"))).toBe("SOURCE_URL_INVALID");
    expect(code(() => resolveSourceUrl("ftp://cdn.example.com/talk.mp4"))).toBe("SOURCE_URL_INVALID");
    expect(code(() => resolveSourceUrl("file:///etc/passwd"))).toBe("SOURCE_URL_INVALID");
    expect(code(() => resolveSourceUrl("not a url"))).toBe("SOURCE_URL_INVALID");
    expect(code(() => resolveSourceUrl("https://user:pw@example.com/x.mp4"))).toBe("SOURCE_URL_INVALID");
  });

  it("rewrites Google Drive share links to the direct download", () => {
    const direct = "https://drive.usercontent.google.com/download?id=1AbC_d-9&export=download&confirm=t";
    expect(resolveSourceUrl("https://drive.google.com/file/d/1AbC_d-9/view?usp=sharing")).toBe(direct);
    expect(resolveSourceUrl("https://drive.google.com/open?id=1AbC_d-9")).toBe(direct);
    expect(resolveSourceUrl("https://drive.google.com/uc?id=1AbC_d-9&export=download")).toBe(direct);
    // A Drive URL that names no file is fetched as is.
    expect(resolveSourceUrl("https://drive.google.com/drive/folders/xyz")).toBe("https://drive.google.com/drive/folders/xyz");
  });

  it("turns a Dropbox preview link into its download", () => {
    expect(resolveSourceUrl("https://www.dropbox.com/s/abc/talk.mp4?dl=0")).toBe("https://www.dropbox.com/s/abc/talk.mp4?dl=1");
    expect(resolveSourceUrl("https://www.dropbox.com/scl/fi/abc/talk.mp4?rlkey=k&dl=0")).toContain("dl=1");
    expect(resolveSourceUrl("https://www.dropbox.com/s/abc/talk.mp4")).toContain("dl=1");
  });

  it("forbids private, loopback, link-local and unspecified addresses, v4 and v6", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1",
      "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "ff02::1", "not-an-ip"]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "142.250.74.14", "2607:f8b0:4004:800::200e", "::ffff:8.8.8.8"]) {
      expect(isForbiddenAddress(ip), ip).toBe(false);
    }
  });

  it("names the stored file by a known video extension only", () => {
    expect(sourceExtension("https://x.com/a/talk.MOV?sig=1", null, null)).toBe("mov");
    expect(sourceExtension("https://drive.usercontent.google.com/download?id=1", "video/mp4", null)).toBe("mp4");
    expect(sourceExtension("https://x.com/download", "application/octet-stream", 'attachment; filename="My talk.webm"')).toBe("webm");
    expect(sourceExtension("https://x.com/evil.sh", "text/html", null)).toBe("bin");
  });
});

const WHISPER = {
  language: "en",
  text: " Hello there world. This is it.",
  segments: [
    { id: 0, start: 0.0, end: 1.6, text: " Hello there world.", words: [{ start: 0.1, end: 0.5, word: " Hello", probability: 0.9 }, { start: 0.5, end: 0.9, word: " there" }, { start: 0.9, end: 1.5, word: " world." }] },
    { id: 1, start: 2.0, end: 3.2, text: " This is it.", words: [{ start: 2.0, end: 2.4, word: " This" }, { start: 2.4, end: 2.6, word: " is" }, { start: 2.6, end: 3.1, word: " it." }] },
  ],
};

describe("reels transcript", () => {
  it("reads whisper word-level output (segments[].words[])", () => {
    const t = normalizeTranscript(WHISPER);
    expect(t.wordTimestamps).toBe("model");
    expect(t.language).toBe("en");
    expect(t.text).toBe("Hello there world. This is it.");
    expect(t.segments).toEqual([{ index: 0, start: 0, end: 1.6, text: "Hello there world." }, { index: 1, start: 2, end: 3.2, text: "This is it." }]);
    expect(t.words.map((w) => w.word)).toEqual(["Hello", "there", "world.", "This", "is", "it."]);
    expect(t.words[0]).toEqual({ start: 0.1, end: 0.5, word: "Hello" });
  });

  it("interpolates words inside each segment when only segments are timed", () => {
    const t = normalizeTranscript({ segments: [{ start: 10, end: 14, text: "aa bbbb" }] });
    expect(t.wordTimestamps).toBe("interpolated");
    // weights 3 and 5 of 8 over 4 s
    expect(t.words).toEqual([{ start: 10, end: 11.5, word: "aa" }, { start: 11.5, end: 14, word: "bbbb" }]);
    expect(t.language).toBeNull();
    expect(interpolateWords(0, 1, "  ")).toEqual([]);
  });

  it("reads a top-level word list and builds segments from it", () => {
    const t = normalizeTranscript({ words: [{ start: 0, end: 0.4, text: "One." }, { start: 0.5, end: 0.9, text: "Two" }, { start: 3, end: 3.4, text: "three" }] });
    expect(t.wordTimestamps).toBe("model");
    expect(t.segments.map((s) => s.text)).toEqual(["One.", "Two", "three"]);
    expect(t.segments.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("refuses an answer with nothing timed", () => {
    expect(() => normalizeTranscript({ text: "hello" })).toThrow(/no segment and no word/);
    expect(() => normalizeTranscript(null)).toThrow();
  });

  it("slices the words of a span by midpoint and prints segment lines", () => {
    const t = normalizeTranscript(WHISPER);
    expect(wordsInSpan(t, 0.5, 2.3).map((w) => w.word)).toEqual(["there", "world.", "This"]);
    expect(textOfSpan(t, 2, 4)).toBe("This is it.");
    expect(segmentLines(t)).toBe("[0] 00:00.0-00:01.6 Hello there world.\n[1] 00:02.0-00:03.2 This is it.");
    expect(clock(221.24)).toBe("03:41.2");
    expect(clock(7199.96)).toBe("120:00.0");
  });

  it("maps segment indexes to a span, null for indexes that do not exist", () => {
    const t = normalizeTranscript(WHISPER);
    expect(spanOfSegments(t, 0, 1)).toEqual({ start: 0, end: 3.2 });
    expect(spanOfSegments(t, 1, 1)).toEqual({ start: 2, end: 3.2 });
    expect(spanOfSegments(t, 1, 0)).toBeNull();
    expect(spanOfSegments(t, 0, 2)).toBeNull();
    expect(spanOfSegments(t, -1, 0)).toBeNull();
    expect(spanOfSegments(t, 0.5, 1)).toBeNull();
  });

  it("re-times a span's words to the cut", () => {
    const t = normalizeTranscript(WHISPER);
    expect(relativeWords(t.words, 2, 3)).toEqual([{ word: "This", start: 0, end: expect.closeTo(0.4) }, { word: "is", start: expect.closeTo(0.4), end: expect.closeTo(0.6) }, { word: "it.", start: expect.closeTo(0.6), end: 1 }]);
  });
});

describe("reels layouts", () => {
  it("fit_blur keeps the whole frame over a blurred copy", () => {
    const g = layoutGraph({ layout: "fit_blur", in: "0:v:0", out: "v" });
    expect(g).toContain("[0:v:0]split=2");
    expect(g).toContain("boxblur");
    expect(g).toContain("force_original_aspect_ratio=decrease");
    expect(g).toContain("overlay=(W-w)/2:(H-h)/2");
    expect(g.endsWith("setsar=1,fps=30,format=yuv420p[v]")).toBe(true);
  });

  it("crop places a 1080-wide window at cropX, clamped", () => {
    expect(layoutGraph({ layout: "crop", cropX: 0.25, in: "0:v", out: "v" })).toContain("crop=1080:1920:(iw-1080)*0.2500:(ih-1920)/2");
    expect(layoutGraph({ layout: "crop", in: "0:v", out: "v" })).toContain("(iw-1080)*0.5000");
    expect(layoutGraph({ layout: "crop", cropX: 7, in: "0:v", out: "v" })).toContain("(iw-1080)*1.0000");
  });

  it("stack puts the left half over the right half, each 1080x960", () => {
    const g = layoutGraph({ layout: "stack", in: "0:v", out: "hv" });
    expect(g).toContain("crop=iw/2:ih:0:0");
    expect(g).toContain("crop=iw/2:ih:iw/2:0");
    expect(g.match(/crop=1080:960/g)).toHaveLength(2);
    expect(g).toContain("vstack=inputs=2");
    expect(g.endsWith("[hv]")).toBe(true);
  });

  it("appends subtitle filters after the pixel format, and escapes their paths", () => {
    const sub = subtitlesFilter("/tmp/reels-x/captions.ass", "/app/assets/reels/fonts");
    expect(sub).toBe("subtitles=filename='/tmp/reels-x/captions.ass':fontsdir='/app/assets/reels/fonts'");
    expect(layoutGraph({ layout: "crop", in: "0:v", out: "v", subtitles: [sub] })).toContain(`format=yuv420p,${sub}[v]`);
    expect(escapeFilterPath("C:\\a b\\it's.ass")).toBe("'C\\\\:\\\\\\\\a b\\\\\\\\it\\\\'\\''s.ass'");
  });

  it("fades the audio 30 ms at a join", () => {
    expect(audioGraph({ in: "0:a:0", out: "a", durationSeconds: 5 })).toBe("[0:a:0]aresample=44100:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo[a]");
    expect(audioGraph({ in: "0:a:0", out: "ha", durationSeconds: 2.5, fadeIn: true, fadeOut: true })).toContain("afade=t=in:st=0:d=0.03,afade=t=out:st=2.470:d=0.03[ha]");
  });
});

describe("reels output check", () => {
  const ok = { durationSeconds: 9.02, video: { codec: "h264", pixFmt: "yuv420p", width: 1080, height: 1920 }, audio: { codec: "aac" } };
  it("passes a deliverable clip", () => {
    expect(() => assertClipDeliverable(ok, 9, 0.2, true)).not.toThrow();
  });
  it("names every miss as OUTPUT_INVALID", () => {
    const bad = { durationSeconds: 9.5, video: { codec: "hevc", pixFmt: "yuv444p", width: 1920, height: 1080 }, audio: null };
    let message = "";
    try { assertClipDeliverable(bad, 9, 0.2, false); } catch (e) { message = (e as ReelsError).message; expect((e as ReelsError).code).toBe("OUTPUT_INVALID"); }
    for (const part of ["hevc", "yuv444p", "1920x1080", "no audio", "9.500s", "faststart"]) expect(message).toContain(part);
    expect(code(() => assertClipDeliverable({ ...ok, durationSeconds: NaN }, 9, 0.2, true))).toBe("OUTPUT_INVALID");
  });
});

describe("reels retention", () => {
  const now = new Date("2026-12-01T00:00:00Z");
  const days = (n: number) => new Date(now.getTime() - n * 86400000);

  it("dates the expiries", () => {
    expect(sourceExpiresAt(new Date("2026-11-01T00:00:00Z"))!.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(clipExpiresAt(new Date("2026-11-01T00:00:00Z"))!.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(sourceExpiresAt(null)).toBeNull();
  });

  it("expires sources after 7 days and clips after 30, once", () => {
    const plan = planRetention({
      now,
      videos: [
        { id: "v-old", status: "ready", readyAt: days(8), sourceDeletedAt: null },
        { id: "v-new", status: "ready", readyAt: days(6), sourceDeletedAt: null },
        { id: "v-gone", status: "ready", readyAt: days(20), sourceDeletedAt: days(13) },
        { id: "v-dl", status: "downloading", readyAt: null, sourceDeletedAt: null },
      ],
      clips: [
        { id: "c-old", status: "done", finishedAt: days(31), fileDeletedAt: null, token: "tok-c-old" },
        { id: "c-new", status: "done", finishedAt: days(29), fileDeletedAt: null, token: "tok-c-new" },
        { id: "c-gone", status: "done", finishedAt: days(60), fileDeletedAt: days(30), token: "tok-c-gone" },
        { id: "c-failed", status: "failed", finishedAt: days(40), fileDeletedAt: null, token: "tok-c-failed" },
      ],
      sourceDirs: [],
      publicDirs: [],
    });
    expect(plan.expireSources).toEqual([{ id: "v-old" }]);
    expect(plan.expireClips).toEqual([{ id: "c-old", token: "tok-c-old" }]);
  });

  it("removes only directories no row names and older than a day", () => {
    const plan = planRetention({
      now,
      videos: [{ id: "v1", status: "ready", readyAt: days(1), sourceDeletedAt: null }, { id: "v2", status: "ready", readyAt: days(9), sourceDeletedAt: days(2) }],
      clips: [{ id: "c1", status: "rendering", finishedAt: null, fileDeletedAt: null, token: "tok-c" }],
      sourceDirs: [{ name: "v1", modifiedAt: days(5) }, { name: "stray-old", modifiedAt: days(2) }, { name: "stray-fresh", modifiedAt: days(0.5) }],
      publicDirs: [{ name: "tok-c", modifiedAt: days(3) }, { name: "tok-expired", modifiedAt: days(3) }, { name: "tok-unknown", modifiedAt: days(3) }, { name: "tok-fresh", modifiedAt: days(0.2) }],
    });
    expect(plan.orphanSourceDirs).toEqual(["stray-old"]);
    expect(plan.orphanPublicDirs).toEqual(["tok-expired", "tok-unknown"]);
  });
});
