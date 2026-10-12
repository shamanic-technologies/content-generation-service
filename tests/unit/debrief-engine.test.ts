import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DebriefVideoRequestSchema } from "../../src/schemas.js";
import { buildSceneData, formatBulletinDate, escapeHtml, INDUSTRY } from "../../src/lib/debrief/scene-data.js";
import { musicCandidates, PROMO_TRACK_ID } from "../../src/lib/debrief/music.js";
import { assertDeliverable } from "../../src/lib/debrief/output-check.js";
import { checkCapture, embedUrl } from "../../src/lib/debrief/capture.js";
import { splitRanges } from "../../src/lib/debrief/render.js";
import { sfxTrack, mixStereo, SAMPLE_RATE } from "../../src/lib/debrief/audio.js";
import { DebriefError } from "../../src/lib/debrief/errors.js";
import { isFaststart } from "../../src/lib/debrief/ffmpeg.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/industry-debrief-2026-10-12.json", import.meta.url), "utf8"));

describe("debrief request", () => {
  it("accepts the 2026-10-12 stories", () => {
    expect(DebriefVideoRequestSchema.safeParse(fixture).success).toBe(true);
  });
  it("refuses one story, five stories, and a third spotlight", () => {
    expect(DebriefVideoRequestSchema.safeParse({ ...fixture, stories: fixture.stories.slice(0, 1) }).success).toBe(false);
    expect(DebriefVideoRequestSchema.safeParse({ ...fixture, stories: [...fixture.stories, ...fixture.stories] }).success).toBe(false);
    const s = { ...fixture.stories[0], spotlight: ["a b c", "d e f", "g h i"] };
    expect(DebriefVideoRequestSchema.safeParse({ ...fixture, stories: [s, fixture.stories[1]] }).success).toBe(false);
  });
});

describe("scene data", () => {
  const data = buildSceneData(DebriefVideoRequestSchema.parse(fixture));
  it("formats the masthead date from the ISO day", () => {
    expect(formatBulletinDate("2026-10-12")).toBe("Monday, Oct 12");
    expect(data.date).toBe("Monday, Oct 12");
  });
  it("counts the stories and the scan in the intro", () => {
    expect(data.industry).toBe(INDUSTRY);
    expect(data.intro.head).toBe("Three things we spotted today");
    expect(data.intro.sub).toBe('<b id="icount">589</b> posts read from the last 36 hours');
  });
  it("maps every story field and keys stories s1..sN", () => {
    expect(data.stories.map((s) => s.key)).toEqual(["s1", "s2", "s3"]);
    expect(data.stories[0]).toMatchObject({ kicker: "SalesCaptain", relation: "own", role: "CEO, SalesCaptain" });
    expect(data.outro.head).toBe(`That was what we spotted today in ${INDUSTRY}. What did we miss?`);
  });
  it("escapes markup the scene would otherwise read as HTML", () => {
    expect(escapeHtml("A & B <i>")).toBe("A &amp; B &lt;i&gt;");
  });
});

describe("music", () => {
  it("never picks the previous track, the promo track, or one shorter than video + 3 s", () => {
    const c = musicCandidates(89.6, 738);
    expect(c).not.toContain(738);
    expect(c).not.toContain(PROMO_TRACK_ID);
    expect(c[0]).toBe(54); // next in rotation after 738 that fits (103 s >= 92.6 s)
    expect(c).toContain(720); // 96 s >= 92.6 s fits
    expect(c).not.toContain(702); // 68 s never does
  });
  it("starts the rotation at the top when there is no previous render", () => {
    expect(musicCandidates(60, null)[0]).toBe(184);
  });
  it("returns nothing when no track outlasts the video", () => {
    expect(musicCandidates(300, null)).toEqual([]);
  });
});

describe("output contract", () => {
  const good = { durationSeconds: 89.6, video: { codec: "h264", pixFmt: "yuv420p", width: 1080, height: 1350 }, audio: { codec: "aac" } };
  it("passes a good file", () => expect(() => assertDeliverable(good, 89.6028, true)).not.toThrow());
  it.each([
    [{ ...good, video: { ...good.video, pixFmt: "yuvj420p" } }, "yuvj420p"],
    [{ ...good, audio: null }, "no audio"],
    [{ ...good, durationSeconds: 80 }, "duration"],
    [{ ...good, video: { ...good.video, codec: "hevc" } }, "hevc"],
  ])("refuses %#", (p, msg) => {
    expect(() => assertDeliverable(p as typeof good, 89.6028, true)).toThrow(msg);
  });
  it("refuses a file that is not faststart", () => {
    expect(() => assertDeliverable(good, 89.6, false)).toThrow(/faststart/);
    expect(isFaststart(Buffer.from("....ftyp....moov....mdat"))).toBe(true);
    expect(isFaststart(Buffer.from("....ftyp....mdat....moov"))).toBe(false);
  });
});

describe("capture check", () => {
  const ok = { marks: { "In 2024, 30 people ran": [[17, 79, 357, 17]] }, who: { name: "Bill", role: "CEO", age: "1h", avatar: null }, H: 1719, textLength: 900 };
  it("builds the embed URLs", () => {
    expect(embedUrl({ platform: "linkedin", activityId: "7515370513691697153" })).toBe("https://www.linkedin.com/embed/feed/update/urn:li:activity:7515370513691697153");
    expect(embedUrl({ platform: "x", tweetId: "2109289938692784499" })).toContain("id=2109289938692784499");
  });
  it("names a phrase that is not verbatim", () => {
    const e = (() => { try { checkCapture(1, "u", { ...ok, marks: { "not there": null } }); } catch (x) { return x; } })() as DebriefError;
    expect(e).toBeInstanceOf(DebriefError);
    expect(e.code).toBe("SPOTLIGHT_NOT_FOUND");
    expect(e.message).toContain('Story 2');
    expect(e.message).toContain('"not there"');
  });
  it("calls an embed with no post unreachable", () => {
    expect(() => checkCapture(0, "u", { ...ok, who: null })).toThrow(expect.objectContaining({ code: "EMBED_UNREACHABLE" }));
    expect(() => checkCapture(0, "u", { ...ok, textLength: 0 })).toThrow(expect.objectContaining({ code: "EMBED_UNREACHABLE" }));
  });
  it("names a crop phrase that is not verbatim", () => {
    expect(() => checkCapture(0, "u", { ...ok, from: null }, "Cost per")).toThrow(expect.objectContaining({ code: "CROP_PHRASE_NOT_FOUND" }));
    expect(checkCapture(0, "u", { ...ok, from: 120 }, "Cost per").from).toBe(120);
  });
});

describe("render split", () => {
  it("cuts on multiples of SUB and covers every sub-frame once", () => {
    const r = splitRanges(5376, 2, 2);
    expect(r).toEqual([[0, 2688], [2688, 5376]]);
    const odd = splitRanges(2 * 1001, 2, 3);
    expect(odd.every(([a]) => a % 2 === 0)).toBe(true);
    expect(odd[0][0]).toBe(0);
    expect(odd.at(-1)![1]).toBe(2002);
    for (let i = 1; i < odd.length; i++) expect(odd[i][0]).toBe(odd[i - 1][1]);
  });
});

describe("audio", () => {
  it("puts each sound's peak on its event and stays inside [-1, 1]", () => {
    const n = SAMPLE_RATE * 2;
    const fx = sfxTrack([{ t: 1, type: "key", p: 1 }], n);
    let pk = 0;
    for (let i = 0; i < n; i++) if (Math.abs(fx[i]) > Math.abs(fx[pk])) pk = i;
    expect(Math.abs(pk - SAMPLE_RATE)).toBeLessThanOrEqual(1);
    const mix = mixStereo(new Float32Array(n * 2).fill(0.9), fx);
    expect(mix.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThanOrEqual(0.97 + 1e-6);
  });
  it("refuses a sound the port does not know", () => {
    expect(() => sfxTrack([{ t: 0, type: "boom" }], 100)).toThrow(DebriefError);
  });
});
