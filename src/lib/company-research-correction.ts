/**
 * Taking back the `company_researched` consumptions this service declared on companies nobody
 * produced (COMPANY-RESEARCHED-PROVENANCE-1024). Pure: the I/O is
 * `src/bin/correct-company-researched.ts`.
 *
 * Before the fix every message consumed `company_researched` on the company of any qualification
 * it was given with checks, researched or not. On 2026-10-24, 376 of 764 such consumptions (342 on
 * workflow-service's execute-workflow runs from the past-email backfill, 34 on our own runs since
 * P1) named a company no run ever declared producing: unknown provenance on the ledger.
 *
 * Per run, the rule is the live one (`withoutUnproducedResearch`), on the ledger as runs-service
 * resolves it: a consumption is valid when a produced `company_researched` of that company was
 * declared before the end of the consumption's UTC day. The plan:
 *   - desired = the companies the run consumes (stored on our rows, or on the ledger) that are valid;
 *   - take back (scoped void: consumed x company_researched, the run stays open, `message_written`
 *     and the pipe's from step untouched) when the ledger holds one not desired, then re-declare the
 *     desired ones at the original consumption instant;
 *   - declare only the missing desired ones when nothing is to take back (a crash between the void
 *     and the re-declaration): re-runnable, a finished run plans nothing.
 */
import { endOfUtcDay } from "./company-research-ledger.js";
import { COMPANY_RESEARCHED } from "./run-outcomes.js";

export interface LedgerConsumption {
  outcomeKey: string;
  subjectId: string;
  /** Effective declaration time (ISO). */
  declaredAt: string;
}

export interface RunCorrectionInput {
  runId: string;
  /** The run's owning service (runs.service_name). */
  serviceName: string;
  /** `company_researched` companies stored on our rows declared on this run. */
  storedDomains: string[];
  /** Every consumption on this run, as the ledger holds it now. */
  ledgerConsumed: LedgerConsumption[];
}

export type RunCorrection =
  | { kind: "none"; runId: string }
  | { kind: "unreadable"; runId: string; reason: string }
  | {
      kind: "take_back" | "declare_missing";
      runId: string;
      serviceName: string;
      /** The instant the run's consumptions were declared (re-declaration keeps it). */
      consumedAt: string;
      takeBack: string[];
      desired: string[];
      missing: string[];
    };

/**
 * `firstProducedAt` = per company, the earliest declaration time of a produced
 * `company_researched` (absent = nobody ever produced it).
 */
export function planRunCorrection(input: RunCorrectionInput, firstProducedAt: ReadonlyMap<string, string>): RunCorrection {
  if (input.ledgerConsumed.length === 0) return { kind: "unreadable", runId: input.runId, reason: "the run holds no consumption on the ledger" };
  const consumedAt = input.ledgerConsumed.map((c) => c.declaredAt).sort()[0];
  const bound = endOfUtcDay(new Date(consumedAt));
  const valid = (d: string) => {
    const at = firstProducedAt.get(d);
    return at !== undefined && new Date(at).getTime() < new Date(bound).getTime();
  };
  const actual = new Set(input.ledgerConsumed.filter((c) => c.outcomeKey === COMPANY_RESEARCHED).map((c) => c.subjectId));
  const desired = [...new Set([...input.storedDomains, ...actual])].filter(valid).sort();
  const takeBack = [...actual].filter((d) => !desired.includes(d)).sort();
  const missing = desired.filter((d) => !actual.has(d));
  if (takeBack.length > 0) return { kind: "take_back", runId: input.runId, serviceName: input.serviceName, consumedAt, takeBack, desired, missing };
  if (missing.length > 0) return { kind: "declare_missing", runId: input.runId, serviceName: input.serviceName, consumedAt, takeBack, desired, missing };
  return { kind: "none", runId: input.runId };
}
