import { describe, it, expect } from "vitest";
import { resolveLeadLanguage } from "../../src/lib/lead-language.js";
import { buildLanguageDirective } from "../../src/lib/chat-service-client.js";

describe("resolveLeadLanguage", () => {
  describe("no directive (English)", () => {
    it("returns null when the field is absent", () => {
      expect(resolveLeadLanguage(undefined)).toBeNull();
    });

    it("returns null when the producer reports it does not know", () => {
      expect(resolveLeadLanguage(null)).toBeNull();
    });

    it("returns null on an empty list", () => {
      expect(resolveLeadLanguage([])).toBeNull();
    });

    it("returns null when the value is not a list at all", () => {
      expect(resolveLeadLanguage("German")).toBeNull();
      expect(resolveLeadLanguage({ 0: "German" })).toBeNull();
    });

    it("returns null when every entry is blank", () => {
      expect(resolveLeadLanguage(["", "   "])).toBeNull();
    });
  });

  describe("English wins wherever it appears — the selected rule", () => {
    it("returns null for English alone", () => {
      expect(resolveLeadLanguage(["English"])).toBeNull();
    });

    it("returns null even when English is NOT the leading language", () => {
      expect(resolveLeadLanguage(["German", "English"])).toBeNull();
      expect(resolveLeadLanguage(["French", "Dutch", "English"])).toBeNull();
    });

    it("matches English in any casing", () => {
      expect(resolveLeadLanguage(["german", "english"])).toBeNull();
      expect(resolveLeadLanguage(["ENGLISH"])).toBeNull();
      expect(resolveLeadLanguage(["  English  "])).toBeNull();
    });
  });

  describe("first of the list — selection is by position", () => {
    it("takes the leading language when there is no English", () => {
      expect(resolveLeadLanguage(["German"])).toBe("German");
      expect(resolveLeadLanguage(["Italian", "German"])).toBe("Italian");
      expect(resolveLeadLanguage(["French", "Dutch"])).toBe("French");
    });

    it("honours the ordering rather than any other property of the list", () => {
      // Same set, different order → different answer. This is the whole reason
      // the ordering guarantee is part of the producer's contract.
      expect(resolveLeadLanguage(["Dutch", "French"])).toBe("Dutch");
      expect(resolveLeadLanguage(["French", "Dutch"])).toBe("French");
    });

    it("skips blank entries and trims the one it returns", () => {
      expect(resolveLeadLanguage(["", " German "])).toBe("German");
    });

    it("ignores non-string entries", () => {
      expect(resolveLeadLanguage([null, 42, "Italian"])).toBe("Italian");
    });
  });
});

describe("buildLanguageDirective", () => {
  it("names the language and demands the whole email in it", () => {
    const directive = buildLanguageDirective("German");
    expect(directive).toContain("Write the ENTIRE email in German");
    expect(directive).toContain("subject line and every step of the sequence");
  });

  it("tells the model the English instructions are not a model for its output", () => {
    // Every stored prompt body is written in English; without this line a model
    // handed English instructions answers in English.
    expect(buildLanguageDirective("Italian")).toContain("NOT a model for the language of your output");
  });

  it("asks for idiomatic business language, not a literal translation", () => {
    const directive = buildLanguageDirective("French");
    expect(directive).toContain("idiomatic French");
    expect(directive).toContain("not a literal translation");
  });
});
