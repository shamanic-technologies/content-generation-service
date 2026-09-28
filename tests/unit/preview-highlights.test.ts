import { describe, it, expect } from "vitest";
import { buildHighlightSources, resolveHighlights } from "../../src/lib/preview-highlights";

const RECIPIENT = { firstName: "Jane", lastName: "Doe", title: "VP Sales", companyName: "Acme", companyIndustry: "" };

const SOURCES = buildHighlightSources({
  recipient: RECIPIENT as any,
  audience: "Heads of sales at US SaaS",
  brandName: "Brand Co",
  brandFields: {
    customerPainPoints: { value: ["Reps spend hours on research", "Low reply rates"] },
    funding: { value: null },
    companyOverview: { value: "We write outbound." },
  },
});

const BODY = "Hi Jane,\n\nYou lead sales at Acme. I'm guessing research eats your reps' week?\n\nBrand Co writes the outbound for you.\n\nIs that the bottleneck?";

describe("buildHighlightSources", () => {
  it("offers only inputs that were actually sent, with their real values", () => {
    const ids = SOURCES.map((s) => s.id);
    expect(ids).toEqual([
      "recipient.firstName",
      "recipient.title",
      "recipient.companyName",
      "audience",
      "brand.name",
      "brand.customerPainPoints",
      "brand.companyOverview",
      "instruction",
    ]);
    expect(SOURCES.find((s) => s.id === "brand.customerPainPoints")).toMatchObject({
      kind: "brand",
      value: "Reps spend hours on research, Low reply rates",
    });
    expect(SOURCES.find((s) => s.id === "instruction")).toMatchObject({ kind: "instruction", value: null });
  });
});

describe("resolveHighlights", () => {
  it("computes offsets from the body and attaches the source kind + real value", () => {
    const [h] = resolveHighlights(
      [{ text: "You lead sales at Acme.", source: "recipient.title", reason: "Her title is VP Sales." }],
      BODY,
      SOURCES
    );
    expect(h).toEqual({
      text: "You lead sales at Acme.",
      start: BODY.indexOf("You lead"),
      end: BODY.indexOf("You lead") + "You lead sales at Acme.".length,
      kind: "prospect",
      source: "recipient.title",
      sourceLabel: "The prospect's job title",
      sourceValue: "VP Sales",
      reason: "Her title is VP Sales.",
    });
    expect(BODY.slice(h.start, h.end)).toBe(h.text);
  });

  it("drops a paraphrase, an unknown or unsent source, and a missing reason", () => {
    const kept = resolveHighlights(
      [
        { text: "You run sales at Acme.", source: "recipient.title", reason: "paraphrased" },
        { text: "Brand Co writes the outbound for you.", source: "brand.funding", reason: "funding was null, never sent" },
        { text: "Is that the bottleneck?", source: "recipient.headline", reason: "headline was never sent" },
        { text: "Is that the bottleneck?", source: "instruction", reason: "  " },
        { text: 42, source: "instruction", reason: "x" },
      ],
      BODY,
      SOURCES
    );
    expect(kept).toEqual([]);
  });

  it("returns spans in body order without overlaps", () => {
    const kept = resolveHighlights(
      [
        { text: "Is that the bottleneck?", source: "instruction", reason: "Diagnostic CTA rule." },
        { text: "Brand Co writes the outbound for you.", source: "brand.companyOverview", reason: "What they do." },
        { text: "Brand Co writes", source: "brand.name", reason: "overlaps the previous one" },
      ],
      BODY,
      SOURCES
    );
    expect(kept.map((h) => h.source)).toEqual(["brand.companyOverview", "instruction"]);
    expect(kept[0].start).toBeLessThan(kept[1].start);
  });

  it("matches text the model returned with over-escaped line breaks", () => {
    const kept = resolveHighlights(
      [{ text: "Hi Jane,\\n\\nYou lead sales at Acme.", source: "recipient.firstName", reason: "Greeting + title." }],
      BODY,
      SOURCES
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].start).toBe(0);
  });
});
