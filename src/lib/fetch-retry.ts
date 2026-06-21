/**
 * Connect-phase retry wrapper around `fetch`.
 *
 * Why this exists: when a Neon-backed sibling (chat-service) has scale-to-zero
 * enabled, its compute suspends after idle. The FIRST outbound request after a
 * suspend lands while the compute is still resuming — the TCP connect times out
 * or is refused before the wake completes, so `fetch` REJECTS (it never returns
 * an HTTP response). Node surfaces this as `TypeError: fetch failed` whose
 * `cause` is `UND_ERR_CONNECT_TIMEOUT` / `ECONNREFUSED` / `ENETUNREACH` /
 * `ETIMEDOUT`. A short retry rides over the ~1–7s resume window.
 *
 * Billing-safety (critical for chat-service `/complete`, which bills LLM tokens
 * and carries NO idempotency key):
 *  - We retry ONLY a *thrown* rejection — never a completed HTTP response. A
 *    402/4xx/5xx is a real answer the server produced (and may have billed);
 *    retrying it could double-bill. The caller handles those statuses.
 *  - We retry ONLY *connect-phase* codes (request never reached the server, so
 *    no spend happened). `ECONNRESET` is deliberately EXCLUDED: it can fire
 *    mid-response, AFTER the LLM already ran and billed — retrying would
 *    double-bill.
 *  - Retries exhausted → the original error is rethrown (fail-loud).
 */

/** Connect-phase error codes: request provably never reached the server. */
const TRANSIENT_CONNECT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = [250, 500, 1000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk an error's `cause` chain and any `AggregateError.errors` siblings,
 * returning true if ANY node carries a connect-phase transient code.
 *
 * Node's happy-eyeballs wraps per-address failures in an `AggregateError`, and
 * `fetch` wraps the underlying connect error under `.cause` — so the transient
 * code can be nested a couple levels down.
 */
export function isTransientConnectError(err: unknown): boolean {
  let depth = 0;
  let current: unknown = err;
  while (current && typeof current === "object" && depth < 6) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CONNECT_CODES.has(code)) {
      return true;
    }
    const aggregate = (current as { errors?: unknown }).errors;
    if (Array.isArray(aggregate) && aggregate.some(isTransientConnectError)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
    depth++;
  }
  return false;
}

export interface FetchRetryOptions {
  maxRetries?: number;
  backoffMs?: number[];
  /** Label used in retry logs (e.g. "chat-service /complete"). */
  label?: string;
}

/**
 * `fetch` with connect-phase retry. Same signature/return as `fetch` — a
 * resolved `Response` (any status) is returned to the caller untouched; only a
 * *thrown* connect-phase rejection is retried.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions = {}
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const label = opts.label ?? url;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastError = err;
      if (!isTransientConnectError(err) || attempt === maxRetries) {
        throw err;
      }
      const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)];
      console.warn(
        `[fetch-retry] transient connect failure for ${label}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  // Unreachable (loop either returns or throws), but satisfies the type checker.
  throw lastError;
}
