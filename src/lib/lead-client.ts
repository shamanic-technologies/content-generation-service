/**
 * HTTP client for lead-service.
 *
 * Reads the one thing this service needs from a lead that the generation request
 * does not carry: `businessLanguages`, the ISO 639-1 codes for the languages the
 * recipient does business in, ordered most-plausible-first. Everything else about
 * the lead already arrives in `variables` from the workflow DAG.
 *
 * Reading it here — by `leadId`, which every generation carries — rather than
 * threading it through the DAG is deliberate: 908 workflows across 570 dynasties
 * call this service, and any one of them not re-templated would silently keep
 * writing in English. Fetching it makes the behaviour hold for all of them at
 * once, including workflows created after this shipped.
 */

import { type Tracking, buildTrackingHeaders } from "./tracking.js";
import { fetchWithRetry } from "./fetch-retry.js";

const LEAD_SERVICE_URL = process.env.LEAD_SERVICE_URL || "http://localhost:3040";
const LEAD_SERVICE_API_KEY = process.env.LEAD_SERVICE_API_KEY || "";

export type LeadServiceIdentity = Tracking;

/**
 * The business languages lead-service reports for a lead — ISO 639-1 codes,
 * ordered most-plausible-first — or `null` when the lead is unreadable, predates
 * the field, or reports none.
 *
 * A failure here NEVER fails the generation. The email is the product; its
 * language is an enrichment on top, and losing the enrichment degrades to
 * exactly the behaviour that shipped for years before it existed. The failure is
 * logged loudly rather than swallowed, and it is a read — nothing has been
 * written or billed at this point. This mirrors how `/generate` already treats a
 * brand-service field extraction that cannot be resolved.
 */
export async function getLeadBusinessLanguages(
  leadId: string,
  identity: LeadServiceIdentity
): Promise<string[] | null> {
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${LEAD_SERVICE_URL}/orgs/leads/${encodeURIComponent(leadId)}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": LEAD_SERVICE_API_KEY,
          ...buildTrackingHeaders(identity),
        },
      },
      { label: "lead-service GET /orgs/leads/{id}" }
    );
  } catch (err) {
    console.error(
      `[lead-client] Could not reach lead-service for lead ${leadId} — generating without a language directive.`,
      err instanceof Error ? err.message : err
    );
    return null;
  }

  if (!response.ok) {
    console.error(
      `[lead-client] lead-service answered ${response.status} for lead ${leadId} — generating without a language directive.`
    );
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    console.error(
      `[lead-client] Unreadable lead-service body for lead ${leadId} — generating without a language directive.`,
      err instanceof Error ? err.message : err
    );
    return null;
  }

  const languages = readBusinessLanguages(body);
  return languages.length > 0 ? languages : null;
}

/**
 * Pull the ordered `businessLanguages` list out of the lead-service payload.
 *
 * `GET /orgs/leads/{id}` wraps the canonical lead as `{ leadDetail: { lead } }`.
 * Both that nesting and the bare lead are accepted so a shape change on the
 * wrapper does not silently drop the field; anything else yields an empty list,
 * which the caller reads as "no directive".
 */
function readBusinessLanguages(body: unknown): string[] {
  const record = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;

  const root = record(body);
  const lead =
    record(record(root?.leadDetail)?.lead) ?? record(root?.lead) ?? root;

  const languages = lead?.businessLanguages;
  if (!Array.isArray(languages)) return [];
  return languages.filter(
    (l): l is string => typeof l === "string" && l.trim().length > 0
  );
}
