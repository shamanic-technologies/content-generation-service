import { describe, expect, it } from "vitest";
import { CHAT_MODELS, MODEL_TO_PROVIDER } from "../../src/lib/chat-models.js";
import {
  PUBLISHED_MODEL_SCHEMAS,
  diffVocabulary,
  extractPublishedVocabulary,
  formatDriftReport,
} from "../../src/lib/model-drift.js";

// Fixtures only — the comparison is pure, so nothing here reaches chat-service. The
// live fetch lives in scripts/check-model-drift.ts and runs in its own CI job, which
// keeps a network blip out of this suite entirely.
function doc(models: string[], providers = ["anthropic", "google"]) {
  const modelProp = { type: "string", enum: models };
  return {
    components: {
      schemas: {
        CompleteRequest: {
          properties: {
            model: modelProp,
            provider: { type: "string", enum: providers },
          },
        },
        InternalPlatformCompleteRequest: { properties: { model: modelProp } },
      },
    },
  };
}

const OURS = [...CHAT_MODELS];
const OUR_PROVIDERS = [...new Set(Object.values(MODEL_TO_PROVIDER))];

describe("extractPublishedVocabulary", () => {
  it("reads the alias enum from every completion schema plus the provider slugs", () => {
    const vocabulary = extractPublishedVocabulary(doc(["haiku", "pro"]));

    expect(Object.keys(vocabulary.models).sort()).toEqual(
      [...PUBLISHED_MODEL_SCHEMAS].sort(),
    );
    expect(vocabulary.models.CompleteRequest).toEqual(["haiku", "pro"]);
    expect(vocabulary.providers).toEqual(["anthropic", "google"]);
  });

  it("throws when a completion schema no longer carries the enum", () => {
    const mangled = doc(["haiku"]) as any;
    delete mangled.components.schemas.InternalPlatformCompleteRequest.properties
      .model;

    expect(() => extractPublishedVocabulary(mangled)).toThrow(
      /InternalPlatformCompleteRequest.*properties\.model\.enum/,
    );
  });

  it("throws on a document with no schemas rather than reporting an empty set as agreement", () => {
    expect(() => extractPublishedVocabulary({})).toThrow(
      /no components\.schemas/,
    );
  });
});

describe("diffVocabulary", () => {
  it("reports no drift when the sets match, whatever the order", () => {
    const report = diffVocabulary(
      extractPublishedVocabulary(doc([...OURS].reverse(), OUR_PROVIDERS)),
      OURS,
      OUR_PROVIDERS,
    );

    expect(report.hasDrift).toBe(false);
    expect(report.schemas.every((s) => s.missingHere.length === 0)).toBe(true);
    expect(report.schemas.every((s) => s.staleHere.length === 0)).toBe(true);
  });

  // The exact incident this alarm exists for: chat-service ships a model, this
  // service does not learn, and the alias is unusable in a stored workflow.
  it("flags an alias chat-service added here as MISSING", () => {
    const report = diffVocabulary(
      extractPublishedVocabulary(doc([...OURS, "titan-pro"], OUR_PROVIDERS)),
      OURS,
      OUR_PROVIDERS,
    );

    expect(report.hasDrift).toBe(true);
    for (const schema of report.schemas) {
      expect(schema.missingHere).toEqual(["titan-pro"]);
      expect(schema.staleHere).toEqual([]);
    }
  });

  it("flags an alias chat-service retired as STALE", () => {
    const [retired, ...served] = OURS;
    const report = diffVocabulary(
      extractPublishedVocabulary(doc(served, OUR_PROVIDERS)),
      OURS,
      OUR_PROVIDERS,
    );

    expect(report.hasDrift).toBe(true);
    for (const schema of report.schemas) {
      expect(schema.staleHere).toEqual([retired]);
      expect(schema.missingHere).toEqual([]);
    }
  });

  it("flags a rename in both directions at once", () => {
    const renamed = OURS.map((m) => (m === "gpt-pro" ? "gpt-astra" : m));
    const report = diffVocabulary(
      extractPublishedVocabulary(doc(renamed, OUR_PROVIDERS)),
      OURS,
      OUR_PROVIDERS,
    );

    expect(report.schemas[0].missingHere).toEqual(["gpt-astra"]);
    expect(report.schemas[0].staleHere).toEqual(["gpt-pro"]);
  });

  it("flags a provider slug chat-service no longer accepts", () => {
    const report = diffVocabulary(
      extractPublishedVocabulary(
        doc(OURS, ["anthropic", "google", "deepseek", "zai", "moonshot"]),
      ),
      OURS,
      OUR_PROVIDERS,
    );

    expect(report.hasDrift).toBe(true);
    expect(report.unknownProviders).toEqual(["openai"]);
  });

  it("does not read the narrower config-surface enums, which are meant to differ", () => {
    const withConfig = doc(OURS, OUR_PROVIDERS) as any;
    withConfig.components.schemas.AppConfigRequest = {
      properties: { model: { enum: ["haiku"] } },
    };

    expect(
      diffVocabulary(extractPublishedVocabulary(withConfig), OURS, OUR_PROVIDERS)
        .hasDrift,
    ).toBe(false);
  });
});

describe("formatDriftReport", () => {
  it("names each differing alias and the direction it differs in", () => {
    const rendered = formatDriftReport(
      diffVocabulary(
        extractPublishedVocabulary(
          doc([...OURS.filter((m) => m !== "opus"), "titan-pro"], OUR_PROVIDERS),
        ),
        OURS,
        OUR_PROVIDERS,
      ),
    );

    expect(rendered).toContain("MISSING HERE");
    expect(rendered).toContain("titan-pro");
    expect(rendered).toContain("STALE HERE");
    expect(rendered).toContain("opus");
    expect(rendered).toContain("src/lib/chat-models.ts");
  });

  it("says so plainly when the sets agree", () => {
    const rendered = formatDriftReport(
      diffVocabulary(
        extractPublishedVocabulary(doc(OURS, OUR_PROVIDERS)),
        OURS,
        OUR_PROVIDERS,
      ),
    );

    expect(rendered).toContain("matches chat-service");
  });
});
