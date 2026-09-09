/**
 * Fails when the model vocabulary in `src/lib/chat-models.ts` no longer matches the
 * one chat-service publishes.
 *
 * Why this exists: chat-service owns the alias set, this service restates it, and
 * until now the restatement had no way of learning it had fallen behind. The gap is
 * not a runtime bug (chat-service rejects an unknown alias loudly) but it is worse
 * than it looks — workflow-service validates a stored workflow's literal model value
 * against the enum THIS service publishes, so a model chat-service serves perfectly
 * well is unusable, and the workflows cannot even be created. It took a third repo's
 * change to unblock, and nothing warned in between.
 *
 * Usage:
 *   npx tsx scripts/check-model-drift.ts            # exit 1 on drift, 0 otherwise
 *   npx tsx scripts/check-model-drift.ts --strict    # also exit 1 when unreachable
 *
 * Exit codes:
 *   0  vocabularies match, OR chat-service was unreachable (see --strict)
 *   1  vocabularies diverge, or the published document no longer carries the enums
 *
 * Unreachable is NOT a failure by default, and that is the deliberate answer to "how
 * do you keep a network blip from reddening an unrelated build". The comparison is
 * only meaningful when the fetch succeeded; a transport error says nothing about the
 * vocabulary, so it prints loudly and exits 0. What it must never do is print nothing
 * — a silent skip would restore the exact silence this check removes. `--strict` is
 * for a run whose whole purpose is the check (the scheduled job), where "I could not
 * tell" IS worth a red mark.
 *
 * SOURCE: chat-service's committed `openapi.json` on `main`, read raw from GitHub.
 * `main` is what the box deploys, the repo is public so no token is involved, and it
 * updates at MERGE time — one deploy cycle EARLIER than the running service, which is
 * the right side to be early on for an alarm. The deployed document at
 * `https://chat.distribute.you/openapi.json` would be marginally more authoritative
 * and is not usable here: Cloudflare 403s a scripted request with `error code: 1010`
 * whatever the headers.
 */
import {
  diffVocabulary,
  extractPublishedVocabulary,
  formatDriftReport,
} from "../src/lib/model-drift.js";

const SOURCE_URL =
  process.env.CHAT_SERVICE_OPENAPI_URL ??
  "https://raw.githubusercontent.com/shamanic-technologies/chat-service/main/openapi.json";

const ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 3_000];

async function fetchPublishedDocument(): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(SOURCE_URL, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      const wait = BACKOFF_MS[attempt - 1];
      if (wait !== undefined) {
        console.warn(
          `[model-drift] attempt ${attempt}/${ATTEMPTS} failed (${err instanceof Error ? err.message : String(err)}) — retrying in ${wait}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  throw lastError;
}

async function main(): Promise<void> {
  const strict = process.argv.includes("--strict");

  let document: unknown;
  try {
    document = await fetchPublishedDocument();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      [
        "",
        `[model-drift] COULD NOT REACH chat-service's published schema at ${SOURCE_URL}`,
        `[model-drift] ${message}`,
        strict
          ? "[model-drift] --strict: treating an unanswered check as a failure."
          : "[model-drift] A transport error says nothing about the vocabulary, so this is NOT a drift failure. Re-run to check.",
        "",
      ].join("\n"),
    );
    process.exit(strict ? 1 : 0);
  }

  // Past this point every failure is a real one: the document was read, so either the
  // lists differ or the document no longer carries them where it always has.
  const report = diffVocabulary(extractPublishedVocabulary(document));
  const rendered = formatDriftReport(report);

  if (report.hasDrift) {
    console.error(`\n${rendered}\n\nSource: ${SOURCE_URL}\n`);
    process.exit(1);
  }

  console.log(`[model-drift] ${rendered}`);
}

main().catch((err) => {
  console.error(
    `\n[model-drift] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
