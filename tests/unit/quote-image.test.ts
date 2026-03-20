import { describe, it, expect } from "vitest";
import { generateQuoteImage } from "../../src/lib/quote-image.js";

describe("generateQuoteImage", () => {
  it("returns a valid PNG buffer", async () => {
    const buf = await generateQuoteImage({
      name: "Sophie",
      age: 34,
      theme: "Loss of Desire",
      text: "I used to feel everything so deeply. Now I just feel tired.",
    });

    expect(buf).toBeInstanceOf(Buffer);
    // PNG magic bytes: 0x89 0x50 0x4E 0x47
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("handles long text with word wrapping", async () => {
    const buf = await generateQuoteImage({
      name: "Alexandre",
      age: 41,
      theme: "Rebuilding Trust",
      text: "Sometimes the hardest part is not rebuilding what was broken, but accepting that what we build next might look completely different from what we had before, and that is okay.",
    });

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf[0]).toBe(0x89); // PNG header
  });

  it("escapes XML special characters in text", async () => {
    const buf = await generateQuoteImage({
      name: "Jean <Pierre>",
      age: 28,
      theme: "Love & Loss",
      text: 'He said "it\'s over" & walked away.',
    });

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf[0]).toBe(0x89);
  });
});
