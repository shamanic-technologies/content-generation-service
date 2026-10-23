/**
 * The outcome occurrences a writing run produced and consumed (COST-ACCOUNTING-1023-P1).
 *
 * runs-service is the general ledger of what each outcome costs to PRODUCE: a run states what
 * it produced and consumed (`POST /v1/runs/{id}/outcomes`) and runs-service splits the run's
 * cost (its own rows + every descendant that declares nothing, i.e. chat-service's `/complete`)
 * over the produced occurrences. This module holds the declaration this service makes:
 *
 * - every message written for one person (email `/generate`, WhatsApp `/generate-whatsapp`
 *   decision `write`) PRODUCES `message_written` on that person's lead, and CONSUMES the
 *   person's `lead_found`, plus the `company_researched` read when the request carried the
 *   company's checks (`leadQualification` with at least one check);
 * - subject = the person's lead in lead-service (`subjectService: "lead-service"`, the lead id);
 *   the company = lead-service's company key: the `domain` of `leadQualification`, VERBATIM
 *   (lead-service already normalized it; settled with lead-service 2026-10-23, never re-normalize).
 *   `domain: null` or no checks = no company read, nothing consumed.
 *
 * Pure builder here + one HTTP call. Persistence and retry are `outcome-declarations.ts`.
 * Never fails the write: the caller stores the body on the generation row and a sweep sends it.
 */

export const LEAD_SUBJECT_SERVICE = "lead-service";
export const MESSAGE_WRITTEN = "message_written";
export const LEAD_FOUND = "lead_found";
export const COMPANY_RESEARCHED = "company_researched";

export interface OutcomeOccurrence {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
}

export interface OutcomeDeclaration {
  produced: OutcomeOccurrence[];
  consumed: OutcomeOccurrence[];
}

/** The company domain whose checks this request READ, or null when it read none. */
export function researchedCompanyDomain(variables: Record<string, unknown> | null | undefined): string | null {
  const q = variables?.leadQualification;
  if (!q || typeof q !== "object") return null;
  const { domain, checks } = q as { domain?: unknown; checks?: unknown };
  if (!Array.isArray(checks) || checks.length === 0) return null;
  if (typeof domain !== "string" || domain.trim() === "") return null;
  return domain;
}

/**
 * The declaration of one message written for one person. `null` without a lead: there is no
 * subject to name, and an id is never invented (logged by the caller).
 */
export function messageWrittenDeclaration(input: {
  leadId: string | null | undefined;
  variables?: Record<string, unknown> | null;
}): OutcomeDeclaration | null {
  const leadId = input.leadId?.trim();
  if (!leadId) return null;
  const lead = { subjectService: LEAD_SUBJECT_SERVICE, subjectId: leadId };
  const consumed: OutcomeOccurrence[] = [{ outcomeKey: LEAD_FOUND, ...lead }];
  const domain = researchedCompanyDomain(input.variables);
  if (domain) consumed.push({ outcomeKey: COMPANY_RESEARCHED, subjectService: LEAD_SUBJECT_SERVICE, subjectId: domain });
  return { produced: [{ outcomeKey: MESSAGE_WRITTEN, ...lead }], consumed };
}

/** A refusal runs-service will repeat on every retry (bad key, unknown run, wrong org, conflict). */
export class PermanentDeclarationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PermanentDeclarationError";
  }
}

/**
 * Sends one declaration. 200 (`already_recorded`, a replay) and 201 are success. 400/404/409
 * throw `PermanentDeclarationError`; anything else (5xx, 502 catalogue unreadable, network)
 * throws a plain Error and is retried by the sweep.
 */
export async function postRunOutcomes(runId: string, orgId: string, declaration: OutcomeDeclaration): Promise<number> {
  const base = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
  const response = await fetch(`${base}/v1/runs/${encodeURIComponent(runId)}/outcomes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.RUNS_SERVICE_API_KEY || "",
      "x-org-id": orgId,
    },
    body: JSON.stringify(declaration),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) return response.status;
  const text = await response.text().catch(() => "");
  const message = `runs-service POST /v1/runs/${runId}/outcomes failed: ${response.status} - ${text.slice(0, 500)}`;
  if (response.status === 400 || response.status === 404 || response.status === 409) {
    throw new PermanentDeclarationError(response.status, message);
  }
  throw new Error(message);
}
