import { describe, it, expect } from "vitest";
import {
  assTime, buildCaptionsAss, buildHookAss, captionWord, cleanHookLine, escapeAssText, groupCaptionWords, wrapLine,
  CAPTION_MAX_CHARS, CAPTION_MAX_WORDS, HOOK_MAX_LINE_CHARS,
} from "../../src/lib/reels/captions-ass.js";

/** Words 0.3 s long, 0.1 s apart, starting at `at`. */
const timed = (words: string[], at = 0, step = 0.4, length = 0.3) => words.map((word, i) => ({ word, start: at + i * step, end: at + i * step + length }));
const events = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

describe("reels ASS escaping", () => {
  it("leaves no override block, escape or line break in drawn text", () => {
    expect(escapeAssText("a {\\b1}bold{\\b0} move")).toBe("a (⧵b1)bold(⧵b0) move");
    expect(escapeAssText("line one\nline\ttwo\r\n three")).toBe("line one line two three");
    expect(escapeAssText("C:\\N")).not.toContain("\\");
    expect(escapeAssText("  plain  ")).toBe("plain");
  });

  it("formats times in centiseconds", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(3.456)).toBe("0:00:03.46");
    expect(assTime(3725.5)).toBe("1:02:05.50");
    expect(assTime(-1)).toBe("0:00:00.00");
  });

  it("draws a word uppercase without dashes; a lone dash draws nothing", () => {
    expect(captionWord(" hello,")).toBe("HELLO,");
    expect(captionWord("—")).toBe("");
    expect(captionWord("well—known")).toBe("WELL, KNOWN");
    expect(captionWord("{x}")).toBe("(X)");
  });
});

describe("reels caption groups", () => {
  it("holds at most 3 words and 18 characters", () => {
    const groups = groupCaptionWords(timed(["one", "two", "three", "four", "internationally", "big", "a", "b", "c", "d"]));
    for (const g of groups) {
      expect(g.words.length).toBeLessThanOrEqual(CAPTION_MAX_WORDS);
      if (g.words.length > 1) expect(g.words.map((w) => w.word).join(" ").length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    }
    expect(groups.map((g) => g.words.map((w) => w.word).join(" "))).toEqual(["ONE TWO THREE", "FOUR", "INTERNATIONALLY", "BIG A B", "C D"]);
  });

  it("starts a new group after a sentence end or a pause", () => {
    const words = [...timed(["done."], 0), ...timed(["next", "one"], 0.4), ...timed(["later"], 5)];
    expect(groupCaptionWords(words).map((g) => g.words.map((w) => w.word).join(" "))).toEqual(["DONE.", "NEXT ONE", "LATER"]);
  });

  it("extends a group to the next one when the gap is under 0.3 s, not over", () => {
    const groups = groupCaptionWords([...timed(["a", "b", "c"], 0), ...timed(["d"], 1.2), ...timed(["e."], 1.6), ...timed(["f"], 2.5)]);
    expect(groups[0].end).toBeCloseTo(1.2); // last word ended 1.1: gap 0.1 → held to 1.2
    expect(groups[1].end).toBeCloseTo(1.9); // "e." ended 1.9, next starts 2.5: gap 0.6 → not extended
  });
});

describe("reels captions ASS", () => {
  const ass = buildCaptionsAss(timed(["this", "is", "big", "news"], 0.2), 10);

  it("declares the output resolution, the bundled font and the caption style", () => {
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toMatch(/Style: Caption,Montserrat ExtraBold,\d+,&H00FFFFFF/);
  });

  it("writes one event per word state, the spoken word yellow, at y=1350", () => {
    const ev = events(ass);
    expect(ev).toHaveLength(4);
    expect(ev[0]).toBe("Dialogue: 0,0:00:00.20,0:00:00.60,Caption,,0,0,0,,{\\an5\\pos(540,1350)}{\\c&H0000E6FF&}THIS{\\c&H00FFFFFF&} IS BIG");
    expect(ev[1]).toContain("0:00:00.60,0:00:01.00");
    expect(ev[1]).toContain("THIS {\\c&H0000E6FF&}IS{\\c&H00FFFFFF&} BIG");
    expect(ev[2]).toContain("THIS IS {\\c&H0000E6FF&}BIG{\\c&H00FFFFFF&}");
    // the group is held to the next group's start (gap 0.1 s): no flicker
    expect(ev[2]).toContain("0:00:01.00,0:00:01.40");
    expect(ev[3]).toContain("{\\c&H0000E6FF&}NEWS{\\c&H00FFFFFF&}");
    expect(ass).not.toMatch(/\\k\d/);
  });

  it("consecutive events of a group leave no gap", () => {
    const ev = events(ass).slice(0, 3).map((l) => l.split(",").slice(1, 3));
    expect(ev[0][1]).toBe(ev[1][0]);
    expect(ev[1][1]).toBe(ev[2][0]);
  });

  it("clamps events to the cut and drops what falls outside", () => {
    const clipped = events(buildCaptionsAss(timed(["a", "b", "c"], 0.5), 1));
    expect(clipped.length).toBeGreaterThan(0);
    for (const l of clipped) expect(l.split(",")[2] <= "0:00:01.00").toBe(true);
    expect(events(buildCaptionsAss([], 5))).toHaveLength(0);
  });

  it("draws a lone word longer than the budget smaller instead of cutting it", () => {
    const ev = events(buildCaptionsAss(timed(["internationalization!!"]), 5));
    expect(ev[0]).toMatch(/\\fs\d+\}/);
  });

  it("never lets spoken text open an override block", () => {
    const ev = events(buildCaptionsAss(timed(["{\\fs200}boom", "ok"]), 5));
    expect(ev.join("\n")).not.toContain("\\fs200");
  });
});

describe("reels hook line ASS", () => {
  it("wraps to at most 16 characters a line", () => {
    const lines = wrapLine("Nobody talks about why this actually works");
    expect(lines).toEqual(["Nobody talks", "about why this", "actually works"]);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(HOOK_MAX_LINE_CHARS);
    expect(wrapLine("Supercalifragilistic day")).toEqual(["Supercalifragilistic", "day"]);
    expect(wrapLine("   ")).toEqual([]);
  });

  it("strips dashes and collapses the line", () => {
    expect(cleanHookLine("  Stop posting — here's\nwhy ")).toBe("Stop posting, here's why");
  });

  it("shows the line for its seconds on an opaque box in the upper third, fading out", () => {
    const ass = buildHookAss("Nobody talks about {this}", 3);
    expect(ass).toMatch(/Style: Hook,Montserrat ExtraBold,\d+,&H00141414,&H00141414,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,/);
    const ev = events(ass);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toBe("Dialogue: 1,0:00:00.00,0:00:03.00,Hook,,0,0,0,,{\\an5\\pos(540,420)\\fad(0,200)}Nobody talks\\Nabout (this)");
  });
});
