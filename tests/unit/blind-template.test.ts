import { describe, it, expect } from "vitest";
import {
  isBlindTemplateType,
  blindIdentityFromBrands,
  findClientMentions,
  findSequenceClientMentions,
  buildBlindDirective,
  recipientAlreadyKnowsBrand,
} from "../../src/lib/blind-template";

describe("isBlindTemplateType", () => {
  it("covers every version of both blind families, nothing else", () => {
    for (const t of ["blind-discovery-email", "blind-discovery-email-v34", "blind-discovery-email-v9-landing-v3", "feedback-request-blind-email-v1"]) {
      expect(isBlindTemplateType(t)).toBe(true);
    }
    for (const t of ["cold-email-v49", "feedback-request-email-v1", "blind-discovery-emailx", "expert-quote-pitch"]) {
      expect(isBlindTemplateType(t)).toBe(false);
    }
  });
});

describe("blindIdentityFromBrands", () => {
  it("takes the name, its compact spelling, and the domain and url host without www", () => {
    expect(blindIdentityFromBrands([{ name: "Living Vital", domain: "livingvital.ch", url: "https://www.livingvital.ch/de" }])).toEqual({
      names: ["Living Vital", "LivingVital"],
      domains: ["livingvital.ch"],
    });
  });
});

describe("findClientMentions (the leaks measured in prod, 2026-10-17)", () => {
  const cases: Array<[Parameters<typeof blindIdentityFromBrands>[0][0], string]> = [
    [{ name: "Living Vital", domain: "livingvital.ch" }, "Wir von Living Vital produzieren..."],
    [{ name: "Olive", domain: "olive.exchange" }, "Olive is a Solana exchange."],
    [{ name: "Doc Dinners", domain: "docdinners.com" }, "full information: https://www.docdinners.com/events"],
    [{ name: "Distribute.you", domain: "distribute.you" }, "We built distribute.you to run end-to-end outbound as software"],
    [{ name: "webprime", domain: "webprime.com" }, "Subject: WEBPRIME + your site"],
  ];
  for (const [brand, text] of cases) {
    it(`finds ${brand.name} in "${text.slice(0, 40)}"`, () => {
      expect(findClientMentions(text, blindIdentityFromBrands([brand])).length).toBeGreaterThan(0);
    });
  }

  it("matches whole words only", () => {
    const id = blindIdentityFromBrands([{ name: "Olive", domain: "olive.exchange" }]);
    expect(findClientMentions("Olivetti and olives", id)).toEqual([]);
    const d = blindIdentityFromBrands([{ name: "Distribute.you", domain: "distribute.you" }]);
    expect(findClientMentions("We distribute your product.", d)).toEqual([]);
  });

  it("checks the subject and every email", () => {
    const id = blindIdentityFromBrands([{ name: "Doc Dinners", domain: "docdinners.com" }]);
    const mentions = findSequenceClientMentions(
      { subject: "Doc Dinners for your team?", sequence: [{ bodyText: "Hi Ann," }, { bodyText: "See docdinners.com" }] },
      id,
    );
    expect(mentions).toEqual([
      { where: "subject", terms: ["Doc Dinners"] },
      { where: "email 2", terms: ["DocDinners", "docdinners.com"] },
    ]);
  });
});

describe("buildBlindDirective", () => {
  it("names the exact strings and overrides the template, the intel and the instruction", () => {
    const d = buildBlindDirective({ names: ["Living Vital"], domains: ["livingvital.ch"] });
    expect(d).toContain('"Living Vital", "livingvital.ch"');
    expect(d).toMatch(/overrides the template, the brand intelligence, the campaign instruction/);
  });
});

describe("recipientAlreadyKnowsBrand", () => {
  it("is false for a stranger (absent, or judged not known with no tag and no thread)", () => {
    expect(recipientAlreadyKnowsBrand(undefined)).toBe(false);
    expect(recipientAlreadyKnowsBrand({ state: "possibly_known", tags: [], hasThread: false })).toBe(false);
    expect(recipientAlreadyKnowsBrand({ state: "not_known", tags: [] })).toBe(false);
  });

  it("is true for a signup, a known contact, or an existing thread (warm re-engagement keeps naming the brand)", () => {
    expect(recipientAlreadyKnowsBrand({ state: "not_known", tags: ["prospect"] })).toBe(true);
    expect(recipientAlreadyKnowsBrand({ state: "known", tags: [] })).toBe(true);
    expect(recipientAlreadyKnowsBrand({ state: "possibly_known", tags: [], hasThread: true })).toBe(true);
  });
});
