/**
 * Alarm for drift between the model vocabulary this service publishes and the one
 * chat-service actually serves.
 *
 * chat-service OWNS that vocabulary: it decides which aliases exist, what each one
 * resolves to, and when one is added or retired. `src/lib/chat-models.ts` restates
 * the list because `schemas.ts` needs it at module-eval time for the `model` Zod
 * enum, and that published constraint is load-bearing — workflow-service validates a
 * stored workflow's literal model value against it, so it is the only thing that
 * rejects a hallucinated model at workflow CREATION time rather than after a run has
 * paid for enrichment. The constraint stays; what this module removes is the SILENCE
 * when the restatement falls behind.
 *
 * This is an ALARM, not a single source. The list still lives in `chat-models.ts`
 * and is still maintained by hand; this compares it against chat-service's published
 * schema and names the aliases that differ, in which direction. Deriving the enum
 * from chat-service at runtime was considered and rejected: it would put a network
 * dependency at module-eval time on a constant ~13 unit suites read through a mocked
 * client, and a chat-service blip would then take down this service's boot.
 *
 * Pure by design — no fetch, no process exit, no environment. The I/O half lives in
 * `scripts/check-model-drift.ts`, so the comparison is unit-testable against fixtures
 * and the test suite never touches the network.
 */
import {
  CHAT_MODELS,
  MODEL_TO_PROVIDER,
  type ChatProvider,
} from "./chat-models.js";

/**
 * The schemas in chat-service's OpenAPI document that carry the alias enum. Both are
 * completion entry points (`POST /complete` and `POST /internal/platform-complete`)
 * and both must agree with the list here — this service calls the first, and the
 * second is the platform-tier sibling a future caller would reach for.
 *
 * NOT included: `AppConfigRequest` / `PlatformConfigRequest`. Those are chat-service's
 * own per-app configuration surface and deliberately expose a NARROWER set (the two
 * native providers only), so comparing them here would alarm on a difference that is
 * chat-service working as intended.
 */
export const PUBLISHED_MODEL_SCHEMAS = [
  "CompleteRequest",
  "InternalPlatformCompleteRequest",
] as const;

export type PublishedModelSchema = (typeof PUBLISHED_MODEL_SCHEMAS)[number];

export interface PublishedVocabulary {
  /** Alias enum per completion schema, keyed by schema name. */
  models: Record<string, string[]>;
  /** Provider slugs chat-service accepts on `POST /complete`. */
  providers: string[];
}

export interface SchemaDrift {
  schema: string;
  /** Served by chat-service, absent from `CHAT_MODELS` — callers cannot use them. */
  missingHere: string[];
  /** In `CHAT_MODELS`, no longer served — this service would 400 at the completion. */
  staleHere: string[];
}

export interface DriftReport {
  schemas: SchemaDrift[];
  /** Provider slugs in `MODEL_TO_PROVIDER` that chat-service no longer accepts. */
  unknownProviders: string[];
  hasDrift: boolean;
}

/**
 * Pull the alias + provider enums out of a chat-service OpenAPI document.
 *
 * Throws rather than degrading: a document that no longer carries these enums where
 * they have always lived is itself a change worth failing on, and a silent empty set
 * would read as "no drift" — the exact silence this module exists to remove.
 */
export function extractPublishedVocabulary(doc: unknown): PublishedVocabulary {
  const schemas = (doc as Record<string, any> | null)?.components?.schemas;
  if (!schemas || typeof schemas !== "object") {
    throw new Error(
      "chat-service OpenAPI document has no components.schemas — cannot read the model vocabulary",
    );
  }

  const models: Record<string, string[]> = {};
  for (const name of PUBLISHED_MODEL_SCHEMAS) {
    const enumValues = schemas[name]?.properties?.model?.enum;
    if (!Array.isArray(enumValues) || enumValues.length === 0) {
      throw new Error(
        `chat-service OpenAPI schema '${name}' has no properties.model.enum — the vocabulary moved, or the schema was renamed`,
      );
    }
    models[name] = enumValues.map(String);
  }

  const providerEnum = schemas.CompleteRequest?.properties?.provider?.enum;
  if (!Array.isArray(providerEnum) || providerEnum.length === 0) {
    throw new Error(
      "chat-service OpenAPI schema 'CompleteRequest' has no properties.provider.enum — the provider slugs moved, or the schema was renamed",
    );
  }

  return { models, providers: providerEnum.map(String) };
}

/**
 * Compare the published vocabulary against this service's own.
 *
 * Order is not compared — the two lists are sets. `MODEL_TO_PROVIDER` is checked for
 * slugs chat-service no longer accepts; the alias→provider ASSIGNMENT is not, because
 * chat-service publishes it only in the prose of its `model` description and an alarm
 * that fires on a reworded sentence is worse than no alarm. A wrong assignment still
 * fails loud at the completion (chat-service 400s a provider/model mismatch).
 */
export function diffVocabulary(
  published: PublishedVocabulary,
  ours: readonly string[] = CHAT_MODELS,
  ourProviders: readonly ChatProvider[] = Object.values(MODEL_TO_PROVIDER),
): DriftReport {
  const oursSet = new Set(ours);

  const schemas: SchemaDrift[] = Object.entries(published.models).map(
    ([schema, theirs]) => {
      const theirsSet = new Set(theirs);
      return {
        schema,
        missingHere: theirs.filter((m) => !oursSet.has(m)).sort(),
        staleHere: [...oursSet].filter((m) => !theirsSet.has(m)).sort(),
      };
    },
  );

  const publishedProviders = new Set(published.providers);
  const unknownProviders = [...new Set(ourProviders)]
    .filter((p) => !publishedProviders.has(p))
    .sort();

  return {
    schemas,
    unknownProviders,
    hasDrift:
      unknownProviders.length > 0 ||
      schemas.some((s) => s.missingHere.length > 0 || s.staleHere.length > 0),
  };
}

/**
 * Human-readable report. Names every differing alias and the direction it differs in,
 * so the failure alone says what to edit — the point of the alarm is that nobody has
 * to go and diff two lists by hand to act on it.
 */
export function formatDriftReport(report: DriftReport): string {
  if (!report.hasDrift) {
    return `Model vocabulary matches chat-service (${report.schemas.length} completion schema(s) checked).`;
  }

  const lines: string[] = [
    "Model vocabulary has DRIFTED from chat-service.",
    "",
  ];

  for (const s of report.schemas) {
    if (s.missingHere.length === 0 && s.staleHere.length === 0) continue;
    lines.push(`  chat-service ${s.schema}:`);
    if (s.missingHere.length > 0) {
      lines.push(
        `    MISSING HERE  (chat-service serves them, CHAT_MODELS does not list them): ${s.missingHere.join(", ")}`,
      );
      lines.push(
        `                  -> add each to CHAT_MODELS + MODEL_TO_PROVIDER in src/lib/chat-models.ts`,
      );
    }
    if (s.staleHere.length > 0) {
      lines.push(
        `    STALE HERE    (CHAT_MODELS lists them, chat-service no longer serves them): ${s.staleHere.join(", ")}`,
      );
      lines.push(
        `                  -> remove each from CHAT_MODELS + MODEL_TO_PROVIDER in src/lib/chat-models.ts`,
      );
    }
    lines.push("");
  }

  if (report.unknownProviders.length > 0) {
    lines.push(
      `  UNKNOWN PROVIDERS (MODEL_TO_PROVIDER maps to slugs chat-service does not accept): ${report.unknownProviders.join(", ")}`,
    );
    lines.push(
      `                  -> repoint those aliases in src/lib/chat-models.ts`,
    );
    lines.push("");
  }

  lines.push(
    "The published `model` enum is a constraint workflow-service validates against, so an alias",
  );
  lines.push(
    "chat-service serves is unusable until it is listed here. Do NOT widen the field to accept",
  );
  lines.push("anything — fix the list.");

  return lines.join("\n");
}
