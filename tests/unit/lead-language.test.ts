import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveLeadLanguage, languageNameFromCode } from "../../src/lib/lead-language.js";
import { buildLanguageDirective } from "../../src/lib/chat-service-client.js";

describe("resolveLeadLanguage", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("no directive (English)", () => {
    it("returns null when the field is absent", () => {
      expect(resolveLeadLanguage(undefined)).toBeNull();
    });

    it("returns null for a lead that predates the field being carried", () => {
      expect(resolveLeadLanguage(null)).toBeNull();
    });

    it("returns null on the empty list — the producer's honest 'no signal'", () => {
      expect(resolveLeadLanguage([])).toBeNull();
    });

    it("returns null when the value is not a list at all", () => {
      expect(resolveLeadLanguage("de")).toBeNull();
      expect(resolveLeadLanguage({ 0: "de" })).toBeNull();
    });

    it("returns null when every entry is blank", () => {
      expect(resolveLeadLanguage(["", "   "])).toBeNull();
    });
  });

  describe("English wins wherever it appears — the selected rule", () => {
    it("returns null for English alone", () => {
      expect(resolveLeadLanguage(["en"])).toBeNull();
    });

    it("returns null even when English is NOT the leading language", () => {
      expect(resolveLeadLanguage(["de", "en"])).toBeNull();
      expect(resolveLeadLanguage(["fr", "nl", "en"])).toBeNull();
    });

    it("tolerates casing and the spelled-out form", () => {
      expect(resolveLeadLanguage(["de", "EN"])).toBeNull();
      expect(resolveLeadLanguage(["  en  "])).toBeNull();
      expect(resolveLeadLanguage(["English"])).toBeNull();
    });
  });

  describe("first of the list — selection is by position", () => {
    it("returns the NAME of the leading language, not its code", () => {
      // "Write the email in de" would instruct an LLM to do nothing useful.
      expect(resolveLeadLanguage(["de"])).toBe("German");
      expect(resolveLeadLanguage(["it", "de"])).toBe("Italian");
      expect(resolveLeadLanguage(["fr", "nl"])).toBe("French");
    });

    it("honours the ordering rather than any other property of the list", () => {
      // Same set, different order -> different answer. This is exactly why the
      // ordering guarantee is part of the producer's contract.
      expect(resolveLeadLanguage(["nl", "fr"])).toBe("Dutch");
      expect(resolveLeadLanguage(["fr", "nl"])).toBe("French");
    });

    it("skips blank entries", () => {
      expect(resolveLeadLanguage(["", " de "])).toBe("German");
    });

    it("ignores non-string entries", () => {
      expect(resolveLeadLanguage([null, 42, "it"])).toBe("Italian");
    });

    it("emits no directive and logs when the leading code is unresolvable", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(resolveLeadLanguage(["zz"])).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });
  });
});

describe("languageNameFromCode", () => {
  it("resolves the ISO 639-1 codes the producer emits", () => {
    expect(languageNameFromCode("de")).toBe("German");
    expect(languageNameFromCode("fr")).toBe("French");
    expect(languageNameFromCode("it")).toBe("Italian");
    expect(languageNameFromCode("nl")).toBe("Dutch");
    expect(languageNameFromCode("en")).toBe("English");
  });

  it("returns null rather than echoing an unknown code back", () => {
    // Intl.DisplayNames returns the input unchanged for a code it does not know;
    // passing that through would produce a meaningless instruction.
    expect(languageNameFromCode("zz")).toBeNull();
    expect(languageNameFromCode("")).toBeNull();
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
    expect(buildLanguageDirective("Italian")).toContain(
      "NOT a model for the language of your output"
    );
  });

  it("asks for idiomatic business language, not a literal translation", () => {
    const directive = buildLanguageDirective("French");
    expect(directive).toContain("idiomatic French");
    expect(directive).toContain("not a literal translation");
  });
});
